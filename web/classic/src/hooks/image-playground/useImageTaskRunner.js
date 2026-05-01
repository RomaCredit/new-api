import { useCallback, useEffect, useRef, useState } from 'react';
import { API } from '../../helpers';

// 异步任务状态机：
//   idle      初始
//   submitting 提交中（向后端 /submit 发请求）
//   running    任务已在后端执行，前端正在轮询
//   success    后端报告成功，images 已就绪
//   failed     后端报告失败 或 提交失败
//   canceled   用户取消
//
// 轮询策略：
//   - 默认 2s 一次
//   - 单页面同时只允许一个进行中任务
//   - 后端任务保留 30 分钟，前端会把 task_id 持久化到 localStorage，
//     页面刷新后能自动接力上次任务（前提是后端还在保留期内）

const POLL_INTERVAL_MS = 2000;
const PERSIST_KEY = 'image_playground_async_task_v1';

function loadPersisted() {
  try {
    const raw = localStorage.getItem(PERSIST_KEY);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object') return null;
    if (!obj.task_id) return null;
    return obj;
  } catch {
    return null;
  }
}

function persist(meta) {
  try {
    if (meta && meta.task_id) {
      localStorage.setItem(PERSIST_KEY, JSON.stringify(meta));
    } else {
      localStorage.removeItem(PERSIST_KEY);
    }
  } catch {
    /* ignore */
  }
}

export function useImageTaskRunner() {
  const [status, setStatus] = useState('idle');
  const [taskId, setTaskId] = useState(null);
  const [meta, setMeta] = useState(null); // { mode, model, prompt, submittedAt, label, ... }
  const [images, setImages] = useState([]);
  const [error, setError] = useState('');
  const [elapsedMs, setElapsedMs] = useState(0);
  const [serverTask, setServerTask] = useState(null); // 最近一次 server 返回的完整任务对象（用于调试展示）

  const pollTimerRef = useRef(null);
  const tickTimerRef = useRef(null);
  const startedAtRef = useRef(0);
  const cancelTokenRef = useRef(0); // 自增标记，确保过期的 fetch 结果被忽略

  // 计时器：基于本地 startedAt（提交时间）
  useEffect(() => {
    if (status !== 'submitting' && status !== 'running') {
      if (tickTimerRef.current) {
        clearInterval(tickTimerRef.current);
        tickTimerRef.current = null;
      }
      return undefined;
    }
    if (!startedAtRef.current) startedAtRef.current = Date.now();
    setElapsedMs(Date.now() - startedAtRef.current);
    tickTimerRef.current = setInterval(() => {
      setElapsedMs(Date.now() - startedAtRef.current);
    }, 1000);
    return () => {
      if (tickTimerRef.current) {
        clearInterval(tickTimerRef.current);
        tickTimerRef.current = null;
      }
    };
  }, [status]);

  const stopPolling = useCallback(() => {
    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  const finalize = useCallback(
    (nextStatus, nextImages, nextError, taskSnapshot) => {
      stopPolling();
      setStatus(nextStatus);
      setImages(nextImages || []);
      setError(nextError || '');
      if (taskSnapshot) setServerTask(taskSnapshot);
      persist(null);
    },
    [stopPolling],
  );

  const pollOnce = useCallback(
    async (id, token) => {
      if (!id || token !== cancelTokenRef.current) return;
      try {
        const res = await API.get(`/api/playground/image/status/${encodeURIComponent(id)}`);
        if (token !== cancelTokenRef.current) return;
        const { success, data, message } = res?.data || {};
        if (!success || !data) {
          // 任务过期 / 不存在：终止轮询
          finalize('failed', [], message || '任务不存在或已过期', null);
          return;
        }
        setServerTask(data);
        if (data.status === 'success') {
          const items = (data.images || [])
            .map((it, idx) => ({
              id: `${id}-${idx}`,
              src: it?.src || it?.url || '',
              url: it?.url || '',
              format: it?.format || '',
            }))
            .filter((it) => it.src);
          finalize('success', items, '', data);
          return;
        }
        if (data.status === 'failed') {
          finalize('failed', [], data.error || '生成失败', data);
          return;
        }
        if (data.status === 'canceled') {
          finalize('canceled', [], data.error || '已取消', data);
          return;
        }
        // pending / running：继续
        setStatus('running');
        pollTimerRef.current = setTimeout(() => pollOnce(id, token), POLL_INTERVAL_MS);
      } catch (err) {
        if (token !== cancelTokenRef.current) return;
        // 短暂网络故障容忍，继续重试，但提供错误指示
        setError(err?.message || '轮询失败');
        pollTimerRef.current = setTimeout(() => pollOnce(id, token), POLL_INTERVAL_MS);
      }
    },
    [finalize],
  );

  const startPolling = useCallback(
    (id) => {
      stopPolling();
      cancelTokenRef.current += 1;
      const token = cancelTokenRef.current;
      pollOnce(id, token);
    },
    [pollOnce, stopPolling],
  );

  const submit = useCallback(
    async (payload, displayMeta) => {
      cancelTokenRef.current += 1; // 新任务，作废上一个轮询
      stopPolling();

      setStatus('submitting');
      setImages([]);
      setError('');
      setServerTask(null);
      setElapsedMs(0);
      startedAtRef.current = Date.now();
      const localMeta = { ...(displayMeta || {}), submittedAt: Date.now() };
      setMeta(localMeta);

      try {
        const res = await API.post('/api/playground/image/submit', payload);
        const { success, data, message } = res?.data || {};
        if (!success || !data?.task_id) {
          finalize('failed', [], message || '提交任务失败', null);
          return null;
        }
        const id = data.task_id;
        setTaskId(id);
        persist({ task_id: id, meta: localMeta });
        setStatus('running');
        startPolling(id);
        return id;
      } catch (err) {
        finalize('failed', [], err?.message || '提交任务失败', null);
        return null;
      }
    },
    [finalize, startPolling, stopPolling],
  );

  const cancel = useCallback(async () => {
    if (!taskId) {
      finalize('canceled', [], '', null);
      return;
    }
    try {
      await API.post(`/api/playground/image/cancel/${encodeURIComponent(taskId)}`);
    } catch {
      /* ignore */
    }
    finalize('canceled', [], '已取消', null);
  }, [taskId, finalize]);

  const reset = useCallback(() => {
    cancelTokenRef.current += 1;
    stopPolling();
    setStatus('idle');
    setImages([]);
    setError('');
    setServerTask(null);
    setElapsedMs(0);
    setTaskId(null);
    setMeta(null);
    persist(null);
  }, [stopPolling]);

  // 页面加载时尝试恢复上次任务
  useEffect(() => {
    const persisted = loadPersisted();
    if (!persisted?.task_id) return;
    setTaskId(persisted.task_id);
    setMeta(persisted.meta || null);
    setStatus('running');
    startedAtRef.current = persisted.meta?.submittedAt || Date.now();
    setElapsedMs(Date.now() - startedAtRef.current);
    startPolling(persisted.task_id);
    return () => {
      cancelTokenRef.current += 1;
      stopPolling();
    };
    // 仅启动一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 卸载时停止轮询
  useEffect(() => {
    return () => {
      cancelTokenRef.current += 1;
      stopPolling();
    };
  }, [stopPolling]);

  return {
    status,
    taskId,
    meta,
    images,
    error,
    elapsedMs,
    serverTask,
    submit,
    cancel,
    reset,
    isInflight: status === 'submitting' || status === 'running',
  };
}
