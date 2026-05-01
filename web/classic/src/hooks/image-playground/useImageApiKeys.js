import { useCallback, useEffect, useMemo, useState } from 'react';
import { API, showError } from '../../helpers';
import { fetchTokenKey } from '../../helpers/token';

const ENABLED_TOKEN_STATUS = 1;

export function useImageApiKeys() {
  const isLoggedIn = !!localStorage.getItem('user');
  const [tokens, setTokens] = useState([]);
  const [selectedTokenId, setSelectedTokenId] = useState(null);
  const [resolvedKeys, setResolvedKeys] = useState({});
  const [loading, setLoading] = useState(false);

  const loadTokens = useCallback(async () => {
    if (!isLoggedIn) {
      setTokens([]);
      setSelectedTokenId(null);
      return;
    }

    setLoading(true);
    try {
      const res = await API.get('/api/token/?p=1&size=100');
      const { success, data, message } = res.data || {};
      if (!success) {
        throw new Error(message || 'Failed to load API keys');
      }

      const tokenItems = Array.isArray(data) ? data : data?.items || [];
      const enabledTokens = tokenItems
        .filter((token) => token && typeof token === 'object')
        .filter((token) => token.status === ENABLED_TOKEN_STATUS)
        .filter((token) => token.id !== undefined && token.id !== null);
      setTokens(enabledTokens);
      setSelectedTokenId((prev) => prev || enabledTokens[0]?.id || null);
    } catch (error) {
      showError(error?.message || '加载可用令牌失败');
      setTokens([]);
      setSelectedTokenId(null);
    } finally {
      setLoading(false);
    }
  }, [isLoggedIn]);

  const resolveTokenKey = useCallback(
    async (tokenId) => {
      if (!tokenId) return '';
      if (resolvedKeys[tokenId]) return resolvedKeys[tokenId];
      const key = await fetchTokenKey(tokenId);
      setResolvedKeys((prev) => ({ ...prev, [tokenId]: key }));
      return key;
    },
    [resolvedKeys],
  );

  useEffect(() => {
    loadTokens();
  }, [loadTokens]);

  const selectedToken = useMemo(
    () => tokens.find((token) => token.id === selectedTokenId) || null,
    [tokens, selectedTokenId],
  );

  const selectedKey = selectedTokenId ? resolvedKeys[selectedTokenId] || '' : '';

  return {
    isLoggedIn,
    loading,
    tokens,
    selectedTokenId,
    selectedToken,
    selectedKey,
    setSelectedTokenId,
    resolveTokenKey,
    reloadTokens: loadTokens,
  };
}
