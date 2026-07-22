import axios from 'axios';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:5000';

// Held in module scope, never localStorage/sessionStorage/cookies — it only
// needs to survive the current tab session, and a module-level variable
// disappears on reload exactly like that requirement wants.
let csrfToken = null;

function setCsrfToken(token) {
  csrfToken = token;
}

function getCsrfToken() {
  return csrfToken;
}

const STATE_CHANGING_METHODS = new Set(['post', 'put', 'patch', 'delete']);
const REFRESH_URL = '/api/auth/refresh';

const axiosClient = axios.create({
  baseURL: API_BASE_URL,
  withCredentials: true,
});

axiosClient.interceptors.request.use((config) => {
  const method = (config.method || 'get').toLowerCase();
  if (csrfToken && STATE_CHANGING_METHODS.has(method)) {
    config.headers = config.headers || {};
    config.headers['X-CSRF-Token'] = csrfToken;
  }
  return config;
});

// Coalesces concurrent 401s onto a single in-flight refresh call instead of
// firing one refresh request per failed request.
let refreshPromise = null;

axiosClient.interceptors.response.use(
  (response) => response,
  async (error) => {
    const { config, response } = error;

    if (!config || !response || response.status !== 401 || config._retriedAfterRefresh) {
      return Promise.reject(error);
    }

    // The refresh call itself failing 401 must not trigger another refresh
    // attempt against itself — that would loop forever.
    if (config.url && config.url.includes(REFRESH_URL)) {
      return Promise.reject(error);
    }

    config._retriedAfterRefresh = true;

    try {
      if (!refreshPromise) {
        refreshPromise = axiosClient.post(REFRESH_URL).finally(() => {
          refreshPromise = null;
        });
      }
      await refreshPromise;
      return axiosClient(config);
    } catch (refreshError) {
      return Promise.reject(error);
    }
  }
);

export default axiosClient;
export { setCsrfToken, getCsrfToken };
