package controller

// Backend asynchronous task pipeline for the GPT Image Playground.
//
// 设计目标：
//   1. 前端只负责"提交任务 + 轮询状态 + 展示结果"，不再直连可能耗时数分钟的上游接口；
//   2. 后端创建任务后立即返回 task_id，启动 goroutine 调用本机 /v1/... 复用 newapi 现有
//      的鉴权 / 计费 / relay 重试 / 渠道选择能力；
//   3. 解析上游返回（images API / chat completions 多模态），把图片归一化成可直接渲染的
//      data URL 或 https URL，写回任务对象；
//   4. 通过单实例内存表 (sync.Map) 维护，无需新建数据库表；任务在终态后保留 30 分钟便于
//      前端在不同设备 / 刷新后取回，过期由后台 janitor 清理。
//
// 这不是一个分布式队列。多副本部署时每个节点维护自己的任务表，前端必须在同一节点上完成
// 提交与轮询（典型的反代 sticky-session 即可）。

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"

	"github.com/gin-gonic/gin"
)

// ----- 常量 / 配置 -----

const (
	playgroundEndpointChat            = "chat"
	playgroundEndpointImagesGenerate  = "images_generate"
	playgroundEndpointImagesEdit      = "images_edit"

	playgroundStatusPending  = "pending"
	playgroundStatusRunning  = "running"
	playgroundStatusSuccess  = "success"
	playgroundStatusFailed   = "failed"
	playgroundStatusCanceled = "canceled"

	playgroundDefaultTaskTimeout = 10 * time.Minute
	playgroundTaskRetention      = 30 * time.Minute
	playgroundJanitorInterval    = 1 * time.Minute
	playgroundMaxImageBytes      = 25 * 1024 * 1024 // 25MB upload cap
	playgroundMaxOutputImages    = 8                // 防御性上限
)

// ----- 任务对象 -----

type playgroundImage struct {
	Src    string `json:"src,omitempty"`    // data URL 或 https URL，前端可直接 <img src=...>
	URL    string `json:"url,omitempty"`    // 当上游返回的是 url 时保留原值便于排查
	Format string `json:"format,omitempty"` // 推断的格式（png/jpeg/webp）
}

type playgroundImageTask struct {
	ID          string             `json:"task_id"`
	UserID      int                `json:"-"`
	Endpoint    string             `json:"endpoint"`
	Mode        string             `json:"mode"`  // generate | edit
	Model       string             `json:"model"`
	Prompt      string             `json:"prompt"`
	Status      string             `json:"status"`
	Error       string             `json:"error,omitempty"`
	Images      []playgroundImage  `json:"images,omitempty"`
	SubmittedAt int64              `json:"submitted_at"`
	StartedAt   int64              `json:"started_at,omitempty"`
	FinishedAt  int64              `json:"finished_at,omitempty"`
	UpstreamRaw json.RawMessage    `json:"upstream_raw,omitempty"`
	HTTPStatus  int                `json:"http_status,omitempty"`

	mu       sync.Mutex
	cancel   context.CancelFunc
	expireAt time.Time
}

// snapshot 返回一个可安全 JSON 序列化的副本（不含锁/cancel）
func (t *playgroundImageTask) snapshot() map[string]any {
	t.mu.Lock()
	defer t.mu.Unlock()
	now := time.Now().UnixMilli()
	endedAt := t.FinishedAt
	if endedAt == 0 && t.Status != playgroundStatusSuccess && t.Status != playgroundStatusFailed && t.Status != playgroundStatusCanceled {
		endedAt = now
	}
	startedAt := t.StartedAt
	if startedAt == 0 {
		startedAt = t.SubmittedAt
	}
	return map[string]any{
		"task_id":      t.ID,
		"status":       t.Status,
		"endpoint":     t.Endpoint,
		"mode":         t.Mode,
		"model":        t.Model,
		"prompt":       t.Prompt,
		"submitted_at": t.SubmittedAt,
		"started_at":   t.StartedAt,
		"finished_at":  t.FinishedAt,
		"elapsed_ms":   endedAt - startedAt,
		"images":       t.Images,
		"error":        t.Error,
		"http_status":  t.HTTPStatus,
		"upstream_raw": t.UpstreamRaw,
	}
}

// ----- 全局任务存储 -----

var (
	playgroundTasks    sync.Map // task_id -> *playgroundImageTask
	playgroundJanitor  sync.Once
)

func startPlaygroundJanitor() {
	playgroundJanitor.Do(func() {
		go func() {
			ticker := time.NewTicker(playgroundJanitorInterval)
			defer ticker.Stop()
			for range ticker.C {
				now := time.Now()
				playgroundTasks.Range(func(key, value any) bool {
					if task, ok := value.(*playgroundImageTask); ok {
						task.mu.Lock()
						expired := !task.expireAt.IsZero() && now.After(task.expireAt)
						task.mu.Unlock()
						if expired {
							playgroundTasks.Delete(key)
						}
					}
					return true
				})
			}
		}()
	})
}

// ----- HTTP 入口 -----

// 提交体支持两种载荷形态：
//   1. JSON 端点（chat / images_generate）：使用 request_body 直接转发
//   2. multipart 端点（images_edit）：使用 form 字段携带 base64 图片
type playgroundSubmitRequest struct {
	Endpoint    string                 `json:"endpoint"`     // chat | images_generate | images_edit
	TokenID     int                    `json:"token_id"`     // 选定的用户 token，由后端解析为 sk-xxx
	Mode        string                 `json:"mode"`         // generate | edit （仅用于展示 / 历史）
	Model       string                 `json:"model"`        // 仅展示 / 历史
	Prompt      string                 `json:"prompt"`       // 仅展示 / 历史
	RequestBody json.RawMessage        `json:"request_body"` // for chat / images_generate
	Form        *playgroundFormPayload `json:"form"`         // for images_edit
}

type playgroundFormPayload struct {
	Fields        map[string]string `json:"fields"`
	ImageB64      string            `json:"image_b64"`
	ImageFilename string            `json:"image_filename"`
	MaskB64       string            `json:"mask_b64"`
	MaskFilename  string            `json:"mask_filename"`
}

// SubmitPlaygroundImageTask POST /api/playground/image/submit
func SubmitPlaygroundImageTask(c *gin.Context) {
	startPlaygroundJanitor()

	var req playgroundSubmitRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		common.ApiErrorMsg(c, "请求体解析失败："+err.Error())
		return
	}
	if !isPlaygroundEndpointSupported(req.Endpoint) {
		common.ApiErrorMsg(c, "不支持的 endpoint："+req.Endpoint)
		return
	}
	if req.TokenID <= 0 {
		common.ApiErrorMsg(c, "token_id 必填")
		return
	}
	if req.Endpoint == playgroundEndpointImagesEdit {
		if req.Form == nil || strings.TrimSpace(req.Form.ImageB64) == "" {
			common.ApiErrorMsg(c, "图片编辑必须提供 form.image_b64")
			return
		}
		if size := approxBase64Bytes(req.Form.ImageB64) + approxBase64Bytes(req.Form.MaskB64); size > playgroundMaxImageBytes {
			common.ApiErrorMsg(c, "上传图片体积超过 25MB 上限")
			return
		}
	} else if len(req.RequestBody) == 0 {
		common.ApiErrorMsg(c, "request_body 不能为空")
		return
	}

	userID := c.GetInt("id")
	token, err := model.GetTokenByIds(req.TokenID, userID)
	if err != nil || token == nil {
		common.ApiErrorMsg(c, "无法获取所选令牌")
		return
	}
	fullKey := token.GetFullKey()
	if fullKey == "" {
		common.ApiErrorMsg(c, "所选令牌不可用")
		return
	}

	now := time.Now().UnixMilli()
	mode := req.Mode
	if mode == "" {
		if req.Endpoint == playgroundEndpointImagesEdit {
			mode = "edit"
		} else {
			mode = "generate"
		}
	}
	task := &playgroundImageTask{
		ID:          common.GetUUID(),
		UserID:      userID,
		Endpoint:    req.Endpoint,
		Mode:        mode,
		Model:       req.Model,
		Prompt:      truncate(req.Prompt, 2000),
		Status:      playgroundStatusPending,
		SubmittedAt: now,
	}
	playgroundTasks.Store(task.ID, task)

	go runPlaygroundImageTask(task, fullKey, &req)

	common.ApiSuccess(c, gin.H{
		"task_id":      task.ID,
		"submitted_at": task.SubmittedAt,
		"status":       task.Status,
	})
}

// GetPlaygroundImageTaskStatus GET /api/playground/image/status/:id
func GetPlaygroundImageTaskStatus(c *gin.Context) {
	id := strings.TrimSpace(c.Param("id"))
	if id == "" {
		common.ApiErrorMsg(c, "task_id 不能为空")
		return
	}
	v, ok := playgroundTasks.Load(id)
	if !ok {
		common.ApiErrorMsg(c, "任务不存在或已过期")
		return
	}
	task, _ := v.(*playgroundImageTask)
	if task == nil || task.UserID != c.GetInt("id") {
		common.ApiErrorMsg(c, "无权访问该任务")
		return
	}
	common.ApiSuccess(c, task.snapshot())
}

// CancelPlaygroundImageTask POST /api/playground/image/cancel/:id
func CancelPlaygroundImageTask(c *gin.Context) {
	id := strings.TrimSpace(c.Param("id"))
	if id == "" {
		common.ApiErrorMsg(c, "task_id 不能为空")
		return
	}
	v, ok := playgroundTasks.Load(id)
	if !ok {
		common.ApiErrorMsg(c, "任务不存在或已过期")
		return
	}
	task, _ := v.(*playgroundImageTask)
	if task == nil || task.UserID != c.GetInt("id") {
		common.ApiErrorMsg(c, "无权访问该任务")
		return
	}
	task.mu.Lock()
	canceled := false
	if task.Status == playgroundStatusPending || task.Status == playgroundStatusRunning {
		if task.cancel != nil {
			task.cancel()
		}
		task.Status = playgroundStatusCanceled
		task.Error = "用户已取消"
		task.FinishedAt = time.Now().UnixMilli()
		task.expireAt = time.Now().Add(playgroundTaskRetention)
		canceled = true
	}
	task.mu.Unlock()
	common.ApiSuccess(c, gin.H{"canceled": canceled, "task": task.snapshot()})
}

// ----- 工作 goroutine -----

func runPlaygroundImageTask(task *playgroundImageTask, authKey string, req *playgroundSubmitRequest) {
	timeout := playgroundDefaultTaskTimeout
	if envTimeout := os.Getenv("PLAYGROUND_IMAGE_TIMEOUT"); envTimeout != "" {
		if v, err := strconv.Atoi(envTimeout); err == nil && v > 0 {
			timeout = time.Duration(v) * time.Second
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)

	task.mu.Lock()
	task.Status = playgroundStatusRunning
	task.StartedAt = time.Now().UnixMilli()
	task.cancel = cancel
	task.mu.Unlock()

	defer cancel()
	defer func() {
		if r := recover(); r != nil {
			common.SysError(fmt.Sprintf("[playground-image] panic in task %s: %v", task.ID, r))
			finishPlaygroundTask(task, playgroundStatusFailed, fmt.Sprintf("内部错误：%v", r), nil, nil, 0)
		}
	}()

	httpReq, err := buildPlaygroundUpstreamRequest(ctx, req, authKey)
	if err != nil {
		finishPlaygroundTask(task, playgroundStatusFailed, err.Error(), nil, nil, 0)
		return
	}

	client := &http.Client{Timeout: timeout + 30*time.Second}
	resp, err := client.Do(httpReq)
	if err != nil {
		// context canceled 等同于用户取消
		if ctxErr := ctx.Err(); ctxErr != nil {
			task.mu.Lock()
			currentStatus := task.Status
			task.mu.Unlock()
			if currentStatus == playgroundStatusCanceled {
				return
			}
			if errors.Is(ctxErr, context.DeadlineExceeded) {
				finishPlaygroundTask(task, playgroundStatusFailed, "任务超时（默认 10 分钟）", nil, nil, 0)
				return
			}
		}
		finishPlaygroundTask(task, playgroundStatusFailed, "调用上游失败："+err.Error(), nil, nil, 0)
		return
	}
	defer resp.Body.Close()

	bodyBytes, _ := io.ReadAll(io.LimitReader(resp.Body, 64*1024*1024)) // 防御 OOM
	contentType := resp.Header.Get("Content-Type")
	var payload any
	if strings.Contains(contentType, "application/json") || looksLikeJSON(bodyBytes) {
		_ = json.Unmarshal(bodyBytes, &payload)
	}

	rawSnapshot := captureRawSnapshot(bodyBytes)

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		finishPlaygroundTask(task, playgroundStatusFailed,
			extractPlaygroundErrorMessage(payload, bodyBytes, resp.StatusCode),
			nil, rawSnapshot, resp.StatusCode)
		return
	}

	images := extractPlaygroundImages(payload, defaultOutputFormatFromRequest(req))
	if len(images) == 0 {
		finishPlaygroundTask(task, playgroundStatusFailed,
			"上游已返回但未解析到图片，请查看响应详情",
			nil, rawSnapshot, resp.StatusCode)
		return
	}
	if len(images) > playgroundMaxOutputImages {
		images = images[:playgroundMaxOutputImages]
	}
	finishPlaygroundTask(task, playgroundStatusSuccess, "", images, rawSnapshot, resp.StatusCode)
}

func finishPlaygroundTask(task *playgroundImageTask, status, errMsg string, images []playgroundImage, raw json.RawMessage, httpStatus int) {
	task.mu.Lock()
	defer task.mu.Unlock()
	if task.Status == playgroundStatusCanceled {
		return // 用户已取消，结果丢弃
	}
	task.Status = status
	task.Error = errMsg
	task.Images = images
	task.UpstreamRaw = raw
	task.HTTPStatus = httpStatus
	task.FinishedAt = time.Now().UnixMilli()
	task.expireAt = time.Now().Add(playgroundTaskRetention)
}

// ----- 上游请求构造 -----

func buildPlaygroundUpstreamRequest(ctx context.Context, req *playgroundSubmitRequest, authKey string) (*http.Request, error) {
	baseURL := selfBaseURL()
	switch req.Endpoint {
	case playgroundEndpointChat:
		httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost,
			baseURL+"/v1/chat/completions", bytes.NewReader(req.RequestBody))
		if err != nil {
			return nil, err
		}
		httpReq.Header.Set("Content-Type", "application/json")
		setPlaygroundAuthHeader(httpReq, authKey)
		return httpReq, nil
	case playgroundEndpointImagesGenerate:
		httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost,
			baseURL+"/v1/images/generations", bytes.NewReader(req.RequestBody))
		if err != nil {
			return nil, err
		}
		httpReq.Header.Set("Content-Type", "application/json")
		setPlaygroundAuthHeader(httpReq, authKey)
		return httpReq, nil
	case playgroundEndpointImagesEdit:
		body := &bytes.Buffer{}
		w := multipart.NewWriter(body)

		fields := map[string]string{}
		if req.Form != nil {
			fields = req.Form.Fields
		}
		// 强制带上 model（如果调用方未提供）
		if _, ok := fields["model"]; !ok && req.Model != "" {
			if fields == nil {
				fields = map[string]string{}
			}
			fields["model"] = req.Model
		}
		for k, v := range fields {
			if err := w.WriteField(k, v); err != nil {
				return nil, fmt.Errorf("写入 form 字段 %s 失败：%w", k, err)
			}
		}
		// image
		imgBytes, err := decodePlaygroundImagePart(req.Form.ImageB64)
		if err != nil {
			return nil, fmt.Errorf("解码 image_b64 失败：%w", err)
		}
		filename := strings.TrimSpace(req.Form.ImageFilename)
		if filename == "" {
			filename = "image.png"
		}
		if err := writePlaygroundFilePart(w, "image", filename, imgBytes); err != nil {
			return nil, err
		}
		if strings.TrimSpace(req.Form.MaskB64) != "" {
			maskBytes, err := decodePlaygroundImagePart(req.Form.MaskB64)
			if err != nil {
				return nil, fmt.Errorf("解码 mask_b64 失败：%w", err)
			}
			maskName := strings.TrimSpace(req.Form.MaskFilename)
			if maskName == "" {
				maskName = "mask.png"
			}
			if err := writePlaygroundFilePart(w, "mask", maskName, maskBytes); err != nil {
				return nil, err
			}
		}
		if err := w.Close(); err != nil {
			return nil, err
		}
		httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost,
			baseURL+"/v1/images/edits", body)
		if err != nil {
			return nil, err
		}
		httpReq.Header.Set("Content-Type", w.FormDataContentType())
		setPlaygroundAuthHeader(httpReq, authKey)
		return httpReq, nil
	default:
		return nil, fmt.Errorf("不支持的 endpoint：%s", req.Endpoint)
	}
}

func setPlaygroundAuthHeader(req *http.Request, authKey string) {
	key := strings.TrimSpace(authKey)
	if key == "" {
		return
	}
	if !strings.HasPrefix(key, "sk-") && !strings.HasPrefix(strings.ToLower(key), "bearer ") {
		key = "sk-" + key
	}
	if !strings.HasPrefix(strings.ToLower(key), "bearer ") {
		req.Header.Set("Authorization", "Bearer "+key)
	} else {
		req.Header.Set("Authorization", key)
	}
	// 标记请求来自异步 Playground，便于排查
	req.Header.Set("X-Playground-Async", "1")
}

func writePlaygroundFilePart(w *multipart.Writer, field, filename string, data []byte) error {
	h := make(textproto.MIMEHeader)
	h.Set("Content-Disposition", fmt.Sprintf(`form-data; name=%q; filename=%q`, field, filename))
	h.Set("Content-Type", guessImageContentType(filename))
	part, err := w.CreatePart(h)
	if err != nil {
		return fmt.Errorf("创建 multipart part %s 失败：%w", field, err)
	}
	if _, err := part.Write(data); err != nil {
		return fmt.Errorf("写入 multipart part %s 失败：%w", field, err)
	}
	return nil
}

func decodePlaygroundImagePart(b64 string) ([]byte, error) {
	s := strings.TrimSpace(b64)
	if s == "" {
		return nil, errors.New("empty base64")
	}
	// 兼容 data:image/png;base64,xxxx
	if idx := strings.Index(s, "base64,"); idx >= 0 {
		s = s[idx+len("base64,"):]
	}
	s = strings.ReplaceAll(s, "\n", "")
	s = strings.ReplaceAll(s, "\r", "")
	return base64.StdEncoding.DecodeString(s)
}

func approxBase64Bytes(b64 string) int {
	if b64 == "" {
		return 0
	}
	return len(b64) * 3 / 4
}

func guessImageContentType(filename string) string {
	lower := strings.ToLower(filename)
	switch {
	case strings.HasSuffix(lower, ".png"):
		return "image/png"
	case strings.HasSuffix(lower, ".jpg"), strings.HasSuffix(lower, ".jpeg"):
		return "image/jpeg"
	case strings.HasSuffix(lower, ".webp"):
		return "image/webp"
	case strings.HasSuffix(lower, ".gif"):
		return "image/gif"
	default:
		return "application/octet-stream"
	}
}

func selfBaseURL() string {
	port := os.Getenv("PORT")
	if port == "" {
		if common.Port != nil {
			port = strconv.Itoa(*common.Port)
		} else {
			port = "3000"
		}
	}
	host := os.Getenv("PLAYGROUND_SELF_HOST")
	if host == "" {
		host = "127.0.0.1"
	}
	return fmt.Sprintf("http://%s:%s", host, port)
}

func isPlaygroundEndpointSupported(endpoint string) bool {
	switch endpoint {
	case playgroundEndpointChat, playgroundEndpointImagesGenerate, playgroundEndpointImagesEdit:
		return true
	}
	return false
}

// ----- 响应解析 -----

func defaultOutputFormatFromRequest(req *playgroundSubmitRequest) string {
	if req == nil {
		return "png"
	}
	// 从 request_body 里嗅探 output_format
	if len(req.RequestBody) > 0 {
		var obj map[string]any
		if err := json.Unmarshal(req.RequestBody, &obj); err == nil {
			if v, ok := obj["output_format"].(string); ok && v != "" {
				return strings.ToLower(v)
			}
		}
	}
	if req.Form != nil {
		if v, ok := req.Form.Fields["output_format"]; ok && v != "" {
			return strings.ToLower(v)
		}
	}
	return "png"
}

// extractPlaygroundImages 兼容三类响应：
//   1. /v1/images/* 形式：data[].url 或 data[].b64_json
//   2. /v1/chat/completions 多模态：choices[].message.images[]、content[]
//   3. 兜底：deep scan 找 image_url / b64_json
func extractPlaygroundImages(payload any, fallbackFormat string) []playgroundImage {
	if payload == nil {
		return nil
	}
	out := make([]playgroundImage, 0, 4)
	seen := map[string]bool{}
	push := func(src, url, format string) {
		if src == "" {
			return
		}
		if seen[src] {
			return
		}
		seen[src] = true
		out = append(out, playgroundImage{Src: src, URL: url, Format: format})
	}

	root, _ := payload.(map[string]any)
	if root == nil {
		return nil
	}

	// 1) Images API
	if data, ok := root["data"].([]any); ok {
		for _, it := range data {
			obj, _ := it.(map[string]any)
			if obj == nil {
				continue
			}
			if u, ok := obj["url"].(string); ok && u != "" {
				push(u, u, "")
			} else if b64, ok := obj["b64_json"].(string); ok && b64 != "" {
				src := "data:image/" + fallbackFormat + ";base64," + b64
				push(src, "", fallbackFormat)
			}
		}
		if len(out) > 0 {
			return out
		}
	}

	// 2) Chat completions
	if choices, ok := root["choices"].([]any); ok {
		for _, ch := range choices {
			chMap, _ := ch.(map[string]any)
			if chMap == nil {
				continue
			}
			msg, _ := chMap["message"].(map[string]any)
			if msg == nil {
				continue
			}
			// images 数组
			if imgs, ok := msg["images"].([]any); ok {
				for _, im := range imgs {
					switch v := im.(type) {
					case string:
						if src, format := normalizePlaygroundImageURL(v, fallbackFormat); src != "" {
							push(src, "", format)
						}
					case map[string]any:
						if u, ok := v["image_url"].(map[string]any); ok {
							if uu, ok := u["url"].(string); ok {
								if src, format := normalizePlaygroundImageURL(uu, fallbackFormat); src != "" {
									push(src, uu, format)
								}
							}
						} else if uu, ok := v["image_url"].(string); ok {
							if src, format := normalizePlaygroundImageURL(uu, fallbackFormat); src != "" {
								push(src, uu, format)
							}
						} else if uu, ok := v["url"].(string); ok {
							if src, format := normalizePlaygroundImageURL(uu, fallbackFormat); src != "" {
								push(src, uu, format)
							}
						} else if b64, ok := v["b64_json"].(string); ok {
							if src, format := normalizePlaygroundImageURL(b64, fallbackFormat); src != "" {
								push(src, "", format)
							}
						}
					}
				}
			}
			// content 数组
			if content, ok := msg["content"].([]any); ok {
				for _, p := range content {
					pm, _ := p.(map[string]any)
					if pm == nil {
						continue
					}
					if t, _ := pm["type"].(string); t == "image_url" {
						if u, ok := pm["image_url"].(map[string]any); ok {
							if uu, ok := u["url"].(string); ok {
								if src, format := normalizePlaygroundImageURL(uu, fallbackFormat); src != "" {
									push(src, uu, format)
								}
							}
						} else if uu, ok := pm["image_url"].(string); ok {
							if src, format := normalizePlaygroundImageURL(uu, fallbackFormat); src != "" {
								push(src, uu, format)
							}
						}
					}
				}
			}
		}
		if len(out) > 0 {
			return out
		}
	}

	// 3) deep scan 兜底
	deepScanPlaygroundImages(payload, fallbackFormat, push)
	return out
}

func deepScanPlaygroundImages(node any, fallbackFormat string, push func(src, url, format string)) {
	switch v := node.(type) {
	case map[string]any:
		if iu, ok := v["image_url"].(map[string]any); ok {
			if uu, ok := iu["url"].(string); ok {
				if src, format := normalizePlaygroundImageURL(uu, fallbackFormat); src != "" {
					push(src, uu, format)
				}
			}
		} else if iu, ok := v["image_url"].(string); ok {
			if src, format := normalizePlaygroundImageURL(iu, fallbackFormat); src != "" {
				push(src, iu, format)
			}
		}
		if b64, ok := v["b64_json"].(string); ok {
			if src, format := normalizePlaygroundImageURL(b64, fallbackFormat); src != "" {
				push(src, "", format)
			}
		}
		if u, ok := v["url"].(string); ok {
			if t, _ := v["type"].(string); t == "image" || t == "image_url" {
				if src, format := normalizePlaygroundImageURL(u, fallbackFormat); src != "" {
					push(src, u, format)
				}
			}
		}
		for _, val := range v {
			deepScanPlaygroundImages(val, fallbackFormat, push)
		}
	case []any:
		for _, it := range v {
			deepScanPlaygroundImages(it, fallbackFormat, push)
		}
	}
}

// normalizePlaygroundImageURL 把 url / data URL / 裸 base64 归一化为可直接渲染的 src
// 返回 (src, format)
func normalizePlaygroundImageURL(value, fallbackFormat string) (string, string) {
	v := strings.TrimSpace(value)
	if v == "" {
		return "", ""
	}
	if strings.HasPrefix(v, "data:image/") {
		// data:image/png;base64,...
		end := strings.Index(v, ";")
		format := fallbackFormat
		if end > len("data:image/") {
			format = strings.ToLower(v[len("data:image/"):end])
		}
		return v, format
	}
	if strings.HasPrefix(v, "http://") || strings.HasPrefix(v, "https://") {
		return v, ""
	}
	// 裸 base64：> 120 字符且仅包含 base64 字符
	if len(v) >= 120 {
		head := v
		if len(head) > 200 {
			head = head[:200]
		}
		if isBase64Like(head) {
			cleaned := strings.ReplaceAll(strings.ReplaceAll(v, "\n", ""), "\r", "")
			fmt := strings.ToLower(strings.TrimSpace(fallbackFormat))
			if fmt == "" {
				fmt = "png"
			}
			return "data:image/" + fmt + ";base64," + cleaned, fmt
		}
	}
	return "", ""
}

func isBase64Like(s string) bool {
	for _, ch := range s {
		switch {
		case ch >= 'A' && ch <= 'Z':
		case ch >= 'a' && ch <= 'z':
		case ch >= '0' && ch <= '9':
		case ch == '+' || ch == '/' || ch == '=' || ch == '\n' || ch == '\r':
		default:
			return false
		}
	}
	return true
}

func extractPlaygroundErrorMessage(payload any, raw []byte, status int) string {
	enhanceRegionMsg := func(msg string) string {
		lower := strings.ToLower(msg)
		if strings.Contains(lower, "not available in your region") ||
			(strings.Contains(lower, "region") && strings.Contains(lower, "not available")) {
			return msg + "（当前渠道/账号受区域限制；建议切换可用的图像模型，如 gemini-3.1-flash-image-preview，或更换可用区域的上游渠道/账号）"
		}
		return msg
	}

	if obj, ok := payload.(map[string]any); ok {
		if e, ok := obj["error"].(map[string]any); ok {
			if msg, ok := e["message"].(string); ok && msg != "" {
				return enhanceRegionMsg(msg)
			}
		}
		if msg, ok := obj["message"].(string); ok && msg != "" {
			return enhanceRegionMsg(msg)
		}
	}
	text := strings.TrimSpace(string(raw))
	if text == "" {
		return fmt.Sprintf("上游返回 HTTP %d", status)
	}
	if strings.HasPrefix(text, "<") {
		return fmt.Sprintf("上游返回非 JSON（HTTP %d）：可能是渠道未配置该模型或上游返回了 HTML 错误页", status)
	}
	if len(text) > 240 {
		text = text[:240] + "…"
	}
	return fmt.Sprintf("上游 HTTP %d：%s", status, enhanceRegionMsg(text))
}

func captureRawSnapshot(body []byte) json.RawMessage {
	if len(body) == 0 {
		return nil
	}
	if !looksLikeJSON(body) {
		preview := string(body)
		if len(preview) > 1024 {
			preview = preview[:1024] + "…(truncated)"
		}
		buf, _ := json.Marshal(map[string]string{"raw_text": preview})
		return buf
	}
	if len(body) > 64*1024 {
		preview := string(body[:64*1024])
		buf, _ := json.Marshal(map[string]string{"raw_truncated": preview + "…(truncated)"})
		return buf
	}
	return json.RawMessage(body)
}

func looksLikeJSON(b []byte) bool {
	t := bytes.TrimSpace(b)
	if len(t) == 0 {
		return false
	}
	return t[0] == '{' || t[0] == '['
}

func truncate(s string, max int) string {
	if max <= 0 || len(s) <= max {
		return s
	}
	return s[:max] + "…"
}
