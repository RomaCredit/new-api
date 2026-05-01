import React, { useEffect, useMemo, useState } from 'react';
import {
  Avatar,
  Banner,
  Button,
  Card,
  Empty,
  InputNumber,
  Modal,
  Select,
  Spin,
  Tabs,
  Tag,
  TextArea,
  Typography,
  Upload,
} from '@douyinfe/semi-ui';
import { IconImage, IconUpload } from '@douyinfe/semi-icons';
import { useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { showError, showSuccess } from '../../helpers';
import { useImageApiKeys } from '../../hooks/image-playground/useImageApiKeys';
import { useImageTaskRunner } from '../../hooks/image-playground/useImageTaskRunner';

const { Text, Title } = Typography;
const HISTORY_STORAGE_KEY = 'image_playground_history_v1';
const DEFAULT_MODEL = 'gpt-image-2';
const SLOW_HINT_THRESHOLD_MS = 60 * 1000;

const RULES = {
  minPixels: 655360,
  maxPixels: 8294400,
  maxEdge: 3840,
  maxRatio: 3,
  divisibleBy: 16,
};

// API 调用模式：
//   image: 走 OpenAI Images API（/v1/images/generations、/v1/images/edits）
//   chat:  走 Chat Completions 多模态（OpenRouter / Gemini 等以 chat 形式输出图片）
const API_MODE_IMAGE = 'image';
const API_MODE_CHAT = 'chat';
const API_MODE_OPTIONS = [
  { label: 'OpenAI Images API（/images/generations）', value: API_MODE_IMAGE },
  { label: 'Chat Completions 多模态（OpenRouter 等）', value: API_MODE_CHAT },
];

function inferApiMode(modelName) {
  const m = String(modelName || '').toLowerCase();
  if (!m) return API_MODE_IMAGE;
  if (m === 'gpt-image-2') return API_MODE_CHAT;
  if (m.includes('flash-image') || m.includes('image-preview')) return API_MODE_CHAT;
  if (m.startsWith('openrouter/') || m.includes('/')) return API_MODE_CHAT;
  return API_MODE_IMAGE;
}

const MODEL_OPTIONS = [
  { label: 'gpt-image-2 (OpenRouter / chat)', value: 'gpt-image-2' },
  { label: 'gpt-image-1 (OpenAI / images)', value: 'gpt-image-1' },
  { label: 'dall-e-3 (OpenAI / images)', value: 'dall-e-3' },
  { label: 'dall-e-2 (OpenAI / images)', value: 'dall-e-2' },
  {
    label: 'gemini-3.1-flash-image-preview (chat)',
    value: 'gemini-3.1-flash-image-preview',
  },
];

const SIZE_OPTIONS = [
  { label: '1024 × 1024 (1:1)', value: '1024x1024' },
  { label: '1024 × 1536 (2:3)', value: '1024x1536' },
  { label: '1536 × 1024 (3:2)', value: '1536x1024' },
  { label: '2048 × 2048 (1:1)', value: '2048x2048' },
  { label: '3840 × 2160 (16:9)', value: '3840x2160' },
];
const QUALITY_OPTIONS = [
  { label: 'auto', value: 'auto' },
  { label: 'low', value: 'low' },
  { label: 'medium', value: 'medium' },
  { label: 'high', value: 'high' },
];
const OUTPUT_FORMAT_OPTIONS = [
  { label: 'PNG', value: 'png' },
  { label: 'JPEG', value: 'jpeg' },
  { label: 'WEBP', value: 'webp' },
];
const BACKGROUND_OPTIONS = [
  { label: 'auto', value: 'auto' },
  { label: 'transparent', value: 'transparent' },
  { label: 'opaque', value: 'opaque' },
];
const MODERATION_OPTIONS = [
  { label: 'auto', value: 'auto' },
  { label: 'low', value: 'low' },
];

function parseResolution(value) {
  const [w, h] = String(value || '')
    .split('x')
    .map((item) => Number(item));
  return { width: w || 0, height: h || 0 };
}

function validateResolution(width, height) {
  if (!width || !height) return '请输入正确的宽高';
  if (width > RULES.maxEdge || height > RULES.maxEdge) {
    return '分辨率边长不能超过 3840';
  }
  if (width % RULES.divisibleBy !== 0 || height % RULES.divisibleBy !== 0) {
    return '宽高必须是 16 的倍数';
  }
  const ratio = Math.max(width / height, height / width);
  if (ratio > RULES.maxRatio) return '宽高比例不能超过 3:1';
  const pixels = width * height;
  if (pixels < RULES.minPixels || pixels > RULES.maxPixels) {
    return '像素总量不在允许区间（655,360 ~ 8,294,400）';
  }
  return '';
}

function loadHistory() {
  try {
    const parsed = JSON.parse(localStorage.getItem(HISTORY_STORAGE_KEY) || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveHistory(items) {
  try {
    localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(items.slice(0, 30)));
  } catch {
    /* ignore */
  }
}

function formatDurationMs(ms) {
  const s = Math.max(0, Math.floor((ms || 0) / 1000));
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m <= 0) return `${r}s`;
  return `${m}m ${r}s`;
}

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    if (!file) return resolve('');
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      // 去掉 data:*;base64, 前缀，后端 decoder 也兼容带前缀
      const idx = result.indexOf('base64,');
      resolve(idx >= 0 ? result.slice(idx + 'base64,'.length) : result);
    };
    reader.onerror = () => reject(new Error('读取文件失败'));
    reader.readAsDataURL(file);
  });
}

function Field({ label, hint, children }) {
  return (
    <div className='flex flex-col gap-1.5 w-full'>
      <div className='flex items-center justify-between'>
        <Text strong size='small'>
          {label}
        </Text>
        {hint ? (
          <Text type='tertiary' size='small'>
            {hint}
          </Text>
        ) : null}
      </div>
      {children}
    </div>
  );
}

export default function ImagePlaygroundV2() {
  const { t } = useTranslation();
  const location = useLocation();
  const {
    isLoggedIn,
    loading: keysLoading,
    tokens,
    selectedTokenId,
    selectedToken,
    setSelectedTokenId,
  } = useImageApiKeys();

  const {
    status: taskStatus,
    images: taskImages,
    error: taskError,
    elapsedMs,
    serverTask,
    submit: submitTask,
    cancel: cancelTask,
    reset: resetTask,
    isInflight,
  } = useImageTaskRunner();

  const [model, setModel] = useState(DEFAULT_MODEL);
  const [apiMode, setApiMode] = useState(() => inferApiMode(DEFAULT_MODEL));
  const [apiModeAuto, setApiModeAuto] = useState(true);
  const [mode, setMode] = useState('generate');
  const [sizeMode, setSizeMode] = useState('preset');
  const [prompt, setPrompt] = useState('');
  const [editPrompt, setEditPrompt] = useState('');
  const [size, setSize] = useState('1024x1024');
  const [customWidth, setCustomWidth] = useState(1024);
  const [customHeight, setCustomHeight] = useState(1024);
  const [quality, setQuality] = useState('auto');
  const [outputFormat, setOutputFormat] = useState('png');
  const [compression, setCompression] = useState(85);
  const [background, setBackground] = useState('auto');
  const [moderation, setModeration] = useState('auto');
  const [imageCount, setImageCount] = useState(1);
  const [viewMode, setViewMode] = useState('grid');
  const [activeImageIndex, setActiveImageIndex] = useState(0);
  const [displayImages, setDisplayImages] = useState([]);
  const [history, setHistory] = useState(() => loadHistory());
  const [editImageFile, setEditImageFile] = useState(null);
  const [editMaskFile, setEditMaskFile] = useState(null);
  const [debugOpen, setDebugOpen] = useState(false);

  // 自动跟随模型推断 API 模式（除非用户手动改过）
  useEffect(() => {
    if (apiModeAuto) {
      const inferred = inferApiMode(model);
      setApiMode((prev) => (prev === inferred ? prev : inferred));
    }
  }, [model, apiModeAuto]);

  // 任务完成时落地到展示区 + 历史记录 + 用户提示
  useEffect(() => {
    if (taskStatus === 'success' && taskImages.length > 0) {
      setDisplayImages(taskImages);
      setActiveImageIndex(0);
      setHistory((prev) => {
        const next = [
          {
            id: `h-${Date.now()}`,
            mode: serverTask?.mode || mode,
            prompt: serverTask?.prompt || (mode === 'edit' ? editPrompt : prompt),
            createdAt: Date.now(),
            params: {
              model: serverTask?.model || model,
              apiMode,
              size: computedSize,
              quality,
              outputFormat,
              compression,
              background,
              moderation,
              n: imageCount,
            },
            images: taskImages,
            taskId: serverTask?.task_id,
          },
          ...prev,
        ].slice(0, 30);
        saveHistory(next);
        return next;
      });
      showSuccess(t('图片生成成功'));
    } else if (taskStatus === 'failed' && taskError) {
      showError(taskError);
    } else if (taskStatus === 'canceled') {
      // 静默
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskStatus]);

  const keyOptions = useMemo(
    () =>
      tokens
        .filter((token) => token && typeof token === 'object')
        .map((token) => ({
          label: `${token.name || 'Token'} (${token.key || '***'})`,
          value: token.id,
        })),
    [tokens],
  );

  const computedSize = useMemo(
    () => (sizeMode === 'custom' ? `${customWidth}x${customHeight}` : size),
    [sizeMode, customWidth, customHeight, size],
  );

  const resolutionError = useMemo(
    () => (sizeMode === 'custom' ? validateResolution(customWidth, customHeight) : ''),
    [sizeMode, customWidth, customHeight],
  );

  const toLogin = () => {
    const redirect = encodeURIComponent(location.pathname);
    window.location.href = `/login?redirect=${redirect}`;
  };

  const promptLogin = () => {
    Modal.warning({
      title: t('请先登录'),
      content: t('登录后才能生成图片。'),
      okText: t('去登录'),
      cancelText: t('取消'),
      onOk: toLogin,
    });
  };

  const promptNoToken = () => {
    Modal.warning({
      title: t('没有可用令牌'),
      content: t('请先在令牌管理中创建并启用令牌。'),
      okText: t('前往令牌管理'),
      cancelText: t('取消'),
      onOk: () => (window.location.href = '/console/token'),
    });
  };

  const ensureRequestReady = (requiredPrompt, requiresImage) => {
    if (!isLoggedIn) {
      promptLogin();
      return false;
    }
    if (resolutionError) {
      showError(t(resolutionError));
      return false;
    }
    if (!selectedTokenId) {
      promptNoToken();
      return false;
    }
    if (!model || !model.trim()) {
      showError(t('请选择或输入模型名称'));
      return false;
    }
    if (!requiredPrompt.trim()) {
      showError(t('请输入图片提示词'));
      return false;
    }
    if (requiresImage && !editImageFile) {
      showError(t('请先上传待编辑图片'));
      return false;
    }
    if (isInflight) {
      showError(t('已有进行中的任务，请等待完成或取消后再试'));
      return false;
    }
    return true;
  };

  // ====== 构造提交载荷（提交给后端异步任务，不再直连上游） ======
  const buildGeneratePayload = () => {
    if (apiMode === API_MODE_CHAT) {
      const userText = [
        prompt.trim(),
        `Please generate an image with the following constraints if applicable: size=${computedSize}, quality=${quality}, format=${outputFormat}, background=${background}, n=${imageCount}.`,
      ].join('\n');
      return {
        endpoint: 'chat',
        token_id: selectedTokenId,
        mode: 'generate',
        model,
        prompt: prompt.trim(),
        request_body: {
          model,
          messages: [{ role: 'user', content: userText }],
          modalities: ['image', 'text'],
          stream: false,
        },
      };
    }
    return {
      endpoint: 'images_generate',
      token_id: selectedTokenId,
      mode: 'generate',
      model,
      prompt: prompt.trim(),
      request_body: {
        model,
        prompt: prompt.trim(),
        size: computedSize,
        quality,
        output_format: outputFormat,
        background,
        moderation,
        n: imageCount,
        ...(outputFormat !== 'png' ? { output_compression: compression } : {}),
      },
    };
  };

  const buildEditPayload = async () => {
    if (apiMode === API_MODE_CHAT) {
      const sourceB64 = await readFileAsBase64(editImageFile);
      const maskB64 = editMaskFile ? await readFileAsBase64(editMaskFile) : '';
      const content = [
        { type: 'text', text: editPrompt.trim() },
        {
          type: 'image_url',
          image_url: { url: `data:image/${guessImgFormat(editImageFile)};base64,${sourceB64}` },
        },
      ];
      if (maskB64) {
        content.push({
          type: 'text',
          text: 'The next image is a mask; only edit the white regions.',
        });
        content.push({
          type: 'image_url',
          image_url: {
            url: `data:image/${guessImgFormat(editMaskFile)};base64,${maskB64}`,
          },
        });
      }
      return {
        endpoint: 'chat',
        token_id: selectedTokenId,
        mode: 'edit',
        model,
        prompt: editPrompt.trim(),
        request_body: {
          model,
          messages: [{ role: 'user', content }],
          modalities: ['image', 'text'],
          stream: false,
        },
      };
    }

    const sourceB64 = await readFileAsBase64(editImageFile);
    const maskB64 = editMaskFile ? await readFileAsBase64(editMaskFile) : '';
    const fields = {
      model,
      prompt: editPrompt.trim(),
      size: computedSize,
      quality,
      output_format: outputFormat,
      background,
      moderation,
      n: String(imageCount),
    };
    if (outputFormat !== 'png') {
      fields.output_compression = String(compression);
    }
    return {
      endpoint: 'images_edit',
      token_id: selectedTokenId,
      mode: 'edit',
      model,
      prompt: editPrompt.trim(),
      form: {
        fields,
        image_b64: sourceB64,
        image_filename: editImageFile?.name || 'image.png',
        mask_b64: maskB64,
        mask_filename: editMaskFile?.name || '',
      },
    };
  };

  const onGenerate = async () => {
    if (!ensureRequestReady(prompt, false)) return;
    const payload = buildGeneratePayload();
    await submitTask(payload, {
      label: 'generate',
      mode: 'generate',
      model,
      prompt: prompt.trim(),
    });
  };

  const onEdit = async () => {
    if (!ensureRequestReady(editPrompt, true)) return;
    let payload;
    try {
      payload = await buildEditPayload();
    } catch (err) {
      showError(err?.message || t('准备上传图片失败'));
      return;
    }
    await submitTask(payload, {
      label: 'edit',
      mode: 'edit',
      model,
      prompt: editPrompt.trim(),
    });
  };

  const onCancel = () => {
    cancelTask();
  };

  const clearHistory = () => {
    setHistory([]);
    saveHistory([]);
  };

  const activeImage = displayImages[activeImageIndex];
  const slowHint = isInflight && elapsedMs >= SLOW_HINT_THRESHOLD_MS;

  const tokenStatusText = isLoggedIn
    ? selectedToken
      ? t('当前令牌：{{name}}', { name: selectedToken.name })
      : t('暂无可用启用令牌')
    : t('未登录状态下可查看页面，生成时会提示登录');

  const promptPanel = (
    <div className='flex flex-col gap-3'>
      <Field label={t('Prompt')} hint={`${prompt.length} ${t('字符')}`}>
        <TextArea
          rows={5}
          value={prompt}
          onChange={setPrompt}
          placeholder={t(
            '请输入你想生成的图片描述，例如：一只在月光下的赛博朋克猫，霓虹色调，高细节',
          )}
          autosize={{ minRows: 5, maxRows: 10 }}
        />
      </Field>
    </div>
  );

  const editPanel = (
    <div className='flex flex-col gap-3'>
      <Field
        label={t('Edit Prompt')}
        hint={`${editPrompt.length} ${t('字符')}`}
      >
        <TextArea
          rows={4}
          value={editPrompt}
          onChange={setEditPrompt}
          placeholder={t('请输入编辑提示词，描述你想对图片做的修改')}
          autosize={{ minRows: 4, maxRows: 8 }}
        />
      </Field>
      <Field label={t('待编辑图片')} hint={t('必填')}>
        <Upload
          action=''
          accept='image/*'
          limit={1}
          maxSize={20 * 1024}
          beforeUpload={({ file }) => {
            setEditImageFile(file.fileInstance || null);
            return false;
          }}
          onRemove={() => setEditImageFile(null)}
          draggable
          dragMainText={t('点击或拖拽上传待编辑图片')}
          dragSubText={t('支持 PNG / JPEG / WEBP，建议 ≤ 20MB')}
          style={{ width: '100%' }}
        />
      </Field>
      <Field label={t('蒙版（可选）')} hint={t('白色区域将被编辑')}>
        <Upload
          action=''
          accept='image/*'
          limit={1}
          maxSize={20 * 1024}
          beforeUpload={({ file }) => {
            setEditMaskFile(file.fileInstance || null);
            return false;
          }}
          onRemove={() => setEditMaskFile(null)}
          style={{ width: '100%' }}
        >
          <Button icon={<IconUpload />}>{t('选择蒙版图片')}</Button>
        </Upload>
      </Field>
    </div>
  );

  return (
    <div className='mt-[60px] px-4 pb-8'>
      <div className='w-full max-w-[1500px] mx-auto'>
        {/* Page header */}
        <div className='flex items-center justify-between gap-3 mb-4'>
          <div className='flex items-center gap-3'>
            <Avatar color='blue' size='default'>
              <IconImage />
            </Avatar>
            <div className='flex flex-col'>
              <Title heading={4} style={{ margin: 0 }}>
                {t('GPT Image Playground')}
              </Title>
              <Text type='tertiary' size='small'>
                {t(
                  '默认模型：gpt-image-2（通过 OpenRouter，自动以 Chat Completions 多模态调用）。生成调用全部在后端异步执行，前端只负责提交与等待。',
                )}
              </Text>
            </div>
          </div>
          <div className='flex items-center gap-2'>
            {serverTask ? (
              <Button
                size='small'
                type='tertiary'
                onClick={() => setDebugOpen(true)}
              >
                {t('查看任务详情')}
              </Button>
            ) : null}
            {(taskStatus === 'success' ||
              taskStatus === 'failed' ||
              taskStatus === 'canceled') && (
              <Button size='small' type='tertiary' onClick={resetTask}>
                {t('清除任务状态')}
              </Button>
            )}
          </div>
        </div>

        {/* In-flight progress banner */}
        {isInflight ? (
          <Banner
            type={slowHint ? 'warning' : 'info'}
            closeIcon={null}
            className='mb-3'
            description={
              slowHint
                ? t(
                    '后端正在处理图片任务（通常 3-5 分钟）。已等待 {{secs}}。即使关闭本页面，任务依然在后端执行；下次打开本页时会自动取回结果。',
                    { secs: formatDurationMs(elapsedMs) },
                  )
                : t('后端处理中… 已等待 {{secs}}（{{statusName}}）', {
                    secs: formatDurationMs(elapsedMs),
                    statusName:
                      taskStatus === 'submitting'
                        ? t('提交中')
                        : t('运行中'),
                  })
            }
          >
            <div className='flex items-center gap-2'>
              <Spin size='small' />
              <Button size='small' type='tertiary' onClick={onCancel}>
                {t('取消任务')}
              </Button>
            </div>
          </Banner>
        ) : null}

        {/* Failed banner */}
        {taskStatus === 'failed' && taskError ? (
          <Banner
            type='danger'
            closeIcon={null}
            className='mb-3'
            description={t('任务失败：{{msg}}', { msg: taskError })}
          >
            <div className='flex items-center gap-2'>
              <Button
                size='small'
                type='tertiary'
                onClick={() => setDebugOpen(true)}
              >
                {t('查看详情')}
              </Button>
              <Button size='small' onClick={resetTask}>
                {t('忽略')}
              </Button>
            </div>
          </Banner>
        ) : null}

        {/* Top section: controls + result */}
        <div className='grid grid-cols-1 lg:grid-cols-12 gap-4'>
          {/* Left column: controls */}
          <Card
            className='lg:col-span-5'
            bodyStyle={{ padding: 20 }}
            headerStyle={{ padding: '14px 20px' }}
            title={
              <div className='flex items-center justify-between'>
                <Text strong>{t('生成配置')}</Text>
                <Tag color='blue' size='small'>
                  {model || t('未选择')}
                </Tag>
              </div>
            }
          >
            <div className='flex flex-col gap-4'>
              <Field
                label={t('模型 Model')}
                hint={t('可选预设或自行输入渠道支持的模型名')}
              >
                <Select
                  style={{ width: '100%' }}
                  optionList={MODEL_OPTIONS}
                  value={model}
                  filter
                  allowCreate
                  onChange={(v) => setModel(String(v || '').trim())}
                  placeholder='gpt-image-2'
                />
              </Field>

              <Field
                label={t('API 模式')}
                hint={
                  apiModeAuto
                    ? t('已根据模型自动选择')
                    : t('已手动指定（不再随模型变化）')
                }
              >
                <div className='flex items-center gap-2'>
                  <Select
                    style={{ flex: 1 }}
                    optionList={API_MODE_OPTIONS}
                    value={apiMode}
                    onChange={(v) => {
                      setApiMode(v);
                      setApiModeAuto(false);
                    }}
                  />
                  {!apiModeAuto ? (
                    <Button
                      size='small'
                      type='tertiary'
                      onClick={() => {
                        setApiModeAuto(true);
                        setApiMode(inferApiMode(model));
                      }}
                    >
                      {t('恢复自动')}
                    </Button>
                  ) : null}
                </div>
              </Field>

              <Field label={t('API Key')} hint={tokenStatusText}>
                <Select
                  style={{ width: '100%' }}
                  placeholder={
                    isLoggedIn ? t('请选择可用令牌') : t('请先登录后自动加载可用令牌')
                  }
                  optionList={keyOptions}
                  value={selectedTokenId}
                  onChange={setSelectedTokenId}
                  loading={keysLoading}
                  disabled={!isLoggedIn || keyOptions.length === 0}
                />
              </Field>

              {apiMode === API_MODE_CHAT ? (
                <Banner
                  type='info'
                  closeIcon={null}
                  description={t(
                    'Chat 模式：通过 /v1/chat/completions + modalities=image 调用（OpenRouter / Gemini 等）。size、quality、background、n、output_compression 由上游模型决定，可能会被忽略。',
                  )}
                />
              ) : null}

              <Tabs activeKey={mode} type='line' onChange={setMode}>
                <Tabs.TabPane tab={t('生成 Generate')} itemKey='generate'>
                  <div className='pt-3'>{promptPanel}</div>
                </Tabs.TabPane>
                <Tabs.TabPane tab={t('编辑 Edit')} itemKey='edit'>
                  <div className='pt-3'>{editPanel}</div>
                </Tabs.TabPane>
              </Tabs>

              <div className='flex items-center justify-between mt-1'>
                <Text strong>{t('参数设置')}</Text>
                <div className='flex items-center gap-1'>
                  <Tag color='blue' size='small'>
                    {computedSize}
                  </Tag>
                  <Tag color='cyan' size='small'>
                    {outputFormat.toUpperCase()}
                  </Tag>
                </div>
              </div>

              <div className='grid grid-cols-2 gap-3'>
                <Field label={t('尺寸模式')}>
                  <Select
                    style={{ width: '100%' }}
                    optionList={[
                      { label: t('预设尺寸'), value: 'preset' },
                      { label: t('自定义尺寸'), value: 'custom' },
                    ]}
                    value={sizeMode}
                    onChange={setSizeMode}
                  />
                </Field>

                {sizeMode === 'preset' ? (
                  <Field label={t('分辨率')}>
                    <Select
                      style={{ width: '100%' }}
                      optionList={SIZE_OPTIONS}
                      value={size}
                      onChange={setSize}
                    />
                  </Field>
                ) : (
                  <Field label={t('宽 × 高')} hint={t('需为 16 的倍数')}>
                    <div className='flex items-center gap-2'>
                      <InputNumber
                        style={{ width: '100%' }}
                        value={customWidth}
                        min={16}
                        max={3840}
                        step={16}
                        onChange={(v) => setCustomWidth(Number(v || 0))}
                      />
                      <Text type='tertiary'>×</Text>
                      <InputNumber
                        style={{ width: '100%' }}
                        value={customHeight}
                        min={16}
                        max={3840}
                        step={16}
                        onChange={(v) => setCustomHeight(Number(v || 0))}
                      />
                    </div>
                  </Field>
                )}

                <Field label={t('质量 Quality')}>
                  <Select
                    style={{ width: '100%' }}
                    optionList={QUALITY_OPTIONS}
                    value={quality}
                    onChange={setQuality}
                  />
                </Field>
                <Field label={t('输出格式')}>
                  <Select
                    style={{ width: '100%' }}
                    optionList={OUTPUT_FORMAT_OPTIONS}
                    value={outputFormat}
                    onChange={setOutputFormat}
                  />
                </Field>
                <Field label={t('背景 Background')}>
                  <Select
                    style={{ width: '100%' }}
                    optionList={BACKGROUND_OPTIONS}
                    value={background}
                    onChange={setBackground}
                  />
                </Field>
                <Field label={t('审核 Moderation')}>
                  <Select
                    style={{ width: '100%' }}
                    optionList={MODERATION_OPTIONS}
                    value={moderation}
                    onChange={setModeration}
                  />
                </Field>
                <Field label={t('图片数量 N')}>
                  <InputNumber
                    style={{ width: '100%' }}
                    value={imageCount}
                    min={1}
                    max={4}
                    onChange={(v) => setImageCount(Number(v || 1))}
                  />
                </Field>
                <Field
                  label={t('压缩质量')}
                  hint={outputFormat === 'png' ? t('PNG 不适用') : '0 - 100'}
                >
                  <InputNumber
                    style={{ width: '100%' }}
                    value={compression}
                    min={0}
                    max={100}
                    disabled={outputFormat === 'png'}
                    onChange={(v) => setCompression(Number(v || 85))}
                  />
                </Field>
              </div>

              {resolutionError ? (
                <Tag color='red' style={{ alignSelf: 'flex-start' }}>
                  {t(resolutionError)}
                </Tag>
              ) : null}

              <Text type='tertiary' size='small'>
                {t(
                  '说明：尺寸支持预设/自定义；自定义需为 16 的倍数且总像素 0.65M ~ 8.29M；PNG 不启用压缩质量。',
                )}
              </Text>

              <div className='flex gap-2'>
                <Button
                  theme='solid'
                  type='primary'
                  size='large'
                  block
                  loading={isInflight}
                  disabled={isInflight}
                  onClick={mode === 'generate' ? onGenerate : onEdit}
                >
                  {isInflight
                    ? t('生成中… {{secs}}', { secs: formatDurationMs(elapsedMs) })
                    : mode === 'generate'
                    ? t('生成图片')
                    : t('编辑图片')}
                </Button>
                {isInflight ? (
                  <Button size='large' onClick={onCancel}>
                    {t('取消')}
                  </Button>
                ) : null}
              </div>
            </div>
          </Card>

          {/* Right column: result */}
          <Card
            className='lg:col-span-7'
            bodyStyle={{ padding: 20 }}
            headerStyle={{ padding: '14px 20px' }}
            title={
              <div className='flex items-center justify-between'>
                <Text strong>{t('生成结果')}</Text>
                <div className='flex items-center gap-2'>
                  {displayImages.length > 0 ? (
                    <Tag size='small'>{`${activeImageIndex + 1} / ${displayImages.length}`}</Tag>
                  ) : null}
                  <Select
                    style={{ width: 140 }}
                    size='small'
                    optionList={[
                      { label: t('网格视图'), value: 'grid' },
                      { label: t('单图视图'), value: 'single' },
                    ]}
                    value={viewMode}
                    onChange={setViewMode}
                  />
                </div>
              </div>
            }
          >
            {isInflight && displayImages.length === 0 ? (
              <div
                className='rounded-md flex items-center justify-center'
                style={{
                  minHeight: 520,
                  background: 'var(--semi-color-fill-0)',
                  border: '1px dashed var(--semi-color-border)',
                }}
              >
                <div className='flex flex-col items-center gap-3'>
                  <Spin size='large' />
                  <Text type='secondary'>
                    {t('后端正在生成… 已等待 {{secs}}', {
                      secs: formatDurationMs(elapsedMs),
                    })}
                  </Text>
                  {slowHint ? (
                    <Text type='tertiary' size='small'>
                      {t('通常需要 3-5 分钟，可关闭页面，下次打开自动取回结果')}
                    </Text>
                  ) : null}
                </div>
              </div>
            ) : displayImages.length === 0 ? (
              <div
                className='rounded-md flex items-center justify-center'
                style={{
                  minHeight: 520,
                  background: 'var(--semi-color-fill-0)',
                  border: '1px dashed var(--semi-color-border)',
                }}
              >
                <Empty
                  image={<IconImage size='extra-large' style={{ opacity: 0.3 }} />}
                  title={t('暂无图片结果')}
                  description={t('在左侧填写提示词后点击「生成图片」')}
                />
              </div>
            ) : viewMode === 'single' ? (
              <div className='flex flex-col gap-3'>
                <div
                  className='rounded-md overflow-hidden flex items-center justify-center'
                  style={{
                    minHeight: 480,
                    background: 'var(--semi-color-fill-0)',
                    border: '1px solid var(--semi-color-border)',
                  }}
                >
                  <img
                    src={activeImage?.src}
                    alt='generated'
                    style={{ maxHeight: 540, maxWidth: '100%', objectFit: 'contain' }}
                  />
                </div>
                <div className='flex flex-wrap gap-2'>
                  <Button
                    disabled={activeImageIndex <= 0}
                    onClick={() => setActiveImageIndex((v) => Math.max(v - 1, 0))}
                  >
                    {t('上一张')}
                  </Button>
                  <Button
                    disabled={activeImageIndex >= displayImages.length - 1}
                    onClick={() =>
                      setActiveImageIndex((v) =>
                        Math.min(v + 1, displayImages.length - 1),
                      )
                    }
                  >
                    {t('下一张')}
                  </Button>
                  <Button
                    type='tertiary'
                    onClick={() => {
                      const a = document.createElement('a');
                      a.href = activeImage?.src;
                      a.download = `image-${Date.now()}.${outputFormat}`;
                      a.click();
                    }}
                  >
                    {t('下载')}
                  </Button>
                  <Button
                    type='tertiary'
                    onClick={() => {
                      setMode('edit');
                      if (prompt) setEditPrompt(prompt);
                    }}
                  >
                    {t('Send to Edit')}
                  </Button>
                </div>
              </div>
            ) : (
              <div className='grid grid-cols-1 sm:grid-cols-2 gap-3'>
                {displayImages.map((item, idx) => (
                  <div
                    key={item.id}
                    className='rounded-md overflow-hidden cursor-pointer'
                    style={{
                      background: 'var(--semi-color-fill-0)',
                      border: '1px solid var(--semi-color-border)',
                    }}
                    onClick={() => {
                      setViewMode('single');
                      setActiveImageIndex(idx);
                    }}
                  >
                    <img
                      src={item.src}
                      alt='generated'
                      className='w-full block'
                      style={{ aspectRatio: '1 / 1', objectFit: 'cover' }}
                    />
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>

        {/* Bottom section: history */}
        <Card
          className='mt-4'
          bodyStyle={{ padding: 20 }}
          headerStyle={{ padding: '14px 20px' }}
          title={
            <div className='flex items-center justify-between'>
              <Text strong>{t('历史记录')}</Text>
              <Button type='tertiary' size='small' onClick={clearHistory}>
                {t('清空历史')}
              </Button>
            </div>
          }
        >
          {history.length === 0 ? (
            <div
              className='rounded-md flex items-center justify-center'
              style={{
                minHeight: 160,
                background: 'var(--semi-color-fill-0)',
                border: '1px dashed var(--semi-color-border)',
              }}
            >
              <Empty description={t('暂无历史记录')} />
            </div>
          ) : (
            <div className='grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-3'>
              {history.map((item) => (
                <div
                  key={item.id}
                  className='rounded-md overflow-hidden flex flex-col'
                  style={{ border: '1px solid var(--semi-color-border)' }}
                >
                  <div
                    className='flex items-center justify-center'
                    style={{
                      aspectRatio: '1 / 1',
                      background: 'var(--semi-color-fill-0)',
                    }}
                  >
                    {item.images?.[0]?.src ? (
                      <img
                        src={item.images[0].src}
                        alt='history'
                        className='w-full h-full'
                        style={{ objectFit: 'cover' }}
                      />
                    ) : (
                      <Text type='tertiary' size='small'>
                        {t('无预览')}
                      </Text>
                    )}
                  </div>
                  <div className='p-2 flex flex-col gap-1'>
                    <Text ellipsis={{ showTooltip: true }} size='small' strong>
                      {item.prompt || t('（无提示词）')}
                    </Text>
                    <Text type='tertiary' size='small'>
                      {new Date(item.createdAt).toLocaleString()}
                    </Text>
                    <div className='flex flex-wrap gap-1'>
                      <Tag size='small'>{item.params?.model || '-'}</Tag>
                      <Tag size='small'>{item.mode}</Tag>
                      <Tag size='small'>{item.params?.size}</Tag>
                    </div>
                    <div className='flex gap-2 mt-1'>
                      <Button
                        size='small'
                        block
                        onClick={() => {
                          setDisplayImages(item.images || []);
                          setActiveImageIndex(0);
                          setViewMode('single');
                        }}
                      >
                        {t('查看')}
                      </Button>
                      <Button
                        size='small'
                        type='tertiary'
                        block
                        onClick={() => {
                          setMode('edit');
                          setEditPrompt(item.prompt || '');
                          if (item.params?.model) setModel(item.params.model);
                          const { width, height } = parseResolution(
                            item.params?.size || '',
                          );
                          if (width && height) {
                            setSizeMode('custom');
                            setCustomWidth(width);
                            setCustomHeight(height);
                          }
                        }}
                      >
                        {t('Send to Edit')}
                      </Button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      {/* Task detail modal: 展示后端返回的完整任务对象（用于排查） */}
      <Modal
        title={t('任务详情（用于排查）')}
        visible={debugOpen}
        onCancel={() => setDebugOpen(false)}
        footer={null}
        width={780}
      >
        {serverTask ? (
          <div className='flex flex-col gap-2'>
            <div className='flex flex-wrap gap-2'>
              <Tag>{`task: ${serverTask.task_id || '-'}`}</Tag>
              <Tag color='blue'>{serverTask.status}</Tag>
              <Tag>{serverTask.mode}</Tag>
              <Tag>{serverTask.endpoint}</Tag>
              {serverTask.http_status ? (
                <Tag>{`HTTP ${serverTask.http_status}`}</Tag>
              ) : null}
              {serverTask.elapsed_ms ? (
                <Tag>{`${formatDurationMs(serverTask.elapsed_ms)}`}</Tag>
              ) : null}
            </div>
            {serverTask.error ? (
              <Banner
                type='danger'
                closeIcon={null}
                description={serverTask.error}
              />
            ) : null}
            <Text type='tertiary' size='small'>
              {t('如果上游显示已生成但本面板未显示图片，请把下面的内容贴给开发者排查。')}
            </Text>
            <pre
              style={{
                maxHeight: 460,
                overflow: 'auto',
                padding: 12,
                background: 'var(--semi-color-fill-0)',
                border: '1px solid var(--semi-color-border)',
                borderRadius: 6,
                fontSize: 12,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-all',
              }}
            >
              {JSON.stringify(serverTask, null, 2)}
            </pre>
            <div className='flex justify-end gap-2'>
              <Button
                size='small'
                onClick={() => {
                  const txt = JSON.stringify(serverTask, null, 2);
                  if (navigator?.clipboard?.writeText) {
                    navigator.clipboard.writeText(txt);
                    showSuccess(t('已复制到剪贴板'));
                  }
                }}
              >
                {t('复制')}
              </Button>
            </div>
          </div>
        ) : (
          <Empty description={t('暂无任务数据')} />
        )}
      </Modal>
    </div>
  );
}

function guessImgFormat(file) {
  const name = String(file?.name || '').toLowerCase();
  if (name.endsWith('.jpg') || name.endsWith('.jpeg')) return 'jpeg';
  if (name.endsWith('.webp')) return 'webp';
  if (name.endsWith('.gif')) return 'gif';
  return 'png';
}
