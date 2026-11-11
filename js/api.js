/**
 * XDAgent API 服务层
 * 提供与后端 API 交互的方法
 */

const API_BASE_URL = window.API_BASE_URL || (() => {
    if (!/^https?:$/.test(window.location.protocol)) return 'http://127.0.0.1:8000';
    if (window.location.port === '8000') return window.location.origin;
    const url = new URL(window.location.origin);
    url.port = '8000';
    return url.origin;
})();
let authTokenGeneration = 0;

function calculateTokenFingerprint(token) {
    if (!token) return '';
    let hash = 0xcbf29ce484222325n;
    for (let index = 0; index < token.length; index++) {
        hash ^= BigInt(token.charCodeAt(index));
        hash = BigInt.asUintN(64, hash * 0x100000001b3n);
    }
    return `${token.length}:${hash.toString(16)}`;
}

function getCurrentTokenFingerprint() {
    return calculateTokenFingerprint(localStorage.getItem('token') || '');
}

async function parseResponseBody(response) {
    if (response.status === 204) return null;
    const text = await response.text();
    if (!text) return null;

    try {
        return JSON.parse(text);
    } catch (_) {
        return text;
    }
}

function getErrorMessage(errorBody, status) {
    const detail = errorBody && errorBody.detail;
    if (Array.isArray(detail)) {
        return detail.map(item => item.msg || JSON.stringify(item)).join('；');
    }
    if (typeof detail === 'string' && detail) return detail;
    if (detail && typeof detail === 'object' && detail.message) return detail.message;
    if (errorBody && typeof errorBody.message === 'string' && errorBody.message) {
        return errorBody.message;
    }
    if (typeof errorBody === 'string' && errorBody) return errorBody;
    return `请求失败: ${status}`;
}

function createApiError(errorBody, status, tokenGeneration = 0, tokenFingerprint = '') {
    const error = new Error(getErrorMessage(errorBody, status));
    const detail = errorBody && errorBody.detail;
    error.status = status;
    error.isAuthError = status === 401;
    error.error_code = (
        detail && typeof detail === 'object' && !Array.isArray(detail)
            ? detail.error_code
            : null
    ) || (errorBody && typeof errorBody === 'object' ? errorBody.error_code : null);
    // 请求发出时的 token 代次用于避免旧账号的迟到响应误清除新账号。
    error.authTokenGeneration = tokenGeneration;
    error.authTokenFingerprint = tokenFingerprint;
    return error;
}

function validateLoginResponse(response) {
    if (!response || typeof response.token !== 'string' || !response.token ||
        typeof response.user?.username !== 'string' || !response.user.username) {
        const error = new Error('账号服务响应无效，请重新启动后端后重试');
        error.error_code = 'INVALID_ACCOUNT_RESPONSE';
        throw error;
    }
    return response;
}

/**
 * 基础请求方法
 */
async function request(method, endpoint, data = null, options = {}) {
    const url = `${API_BASE_URL}${endpoint}`;
    const {
        timeout = 15000,
        signal: callerSignal,
        headers: optionHeaders = {},
        auth = true,
        ...fetchOptions
    } = options;
    const isFormData = typeof FormData !== 'undefined' && data instanceof FormData;
    const authToken = auth ? (localStorage.getItem('token') || '') : '';
    const requestTokenGeneration = authTokenGeneration;
    const requestTokenFingerprint = calculateTokenFingerprint(authToken);

    const config = {
        headers: {
            ...(isFormData ? {} : { 'Content-Type': 'application/json' }),
            ...optionHeaders,
            ...(authToken ? { 'Authorization': `Bearer ${authToken}` } : {})
        },
        ...fetchOptions,
        method
    };

    if (data !== null && data !== undefined &&
        (method === 'POST' || method === 'PUT' || method === 'PATCH')) {
        config.body = isFormData ? data : JSON.stringify(data);
    }

    // 超时和调用方取消共用一个 signal，并保留取消原因。
    const controller = new AbortController();
    let didTimeout = false;
    const abortFromCaller = () => controller.abort(callerSignal.reason);
    if (callerSignal) {
        if (callerSignal.aborted) {
            abortFromCaller();
        } else {
            callerSignal.addEventListener('abort', abortFromCaller, { once: true });
        }
    }
    const timer = setTimeout(() => {
        didTimeout = true;
        controller.abort();
    }, timeout);
    config.signal = controller.signal;

    try {
        const response = await fetch(url, config);
        const responseBody = await parseResponseBody(response);

        if (!response.ok) {
            const error = createApiError(
                responseBody,
                response.status,
                requestTokenGeneration,
                requestTokenFingerprint
            );
            error.retryAfter = Number(response.headers.get('Retry-After')) || 0;
            if (response.status === 429 && error.retryAfter) {
                error.message = `尝试过于频繁，请在 ${error.retryAfter} 秒后再试`;
            }
            throw error;
        }

        return responseBody;
    } catch (error) {
        if (didTimeout) {
            const timeoutError = new Error('请求超时，请检查后端服务是否启动');
            timeoutError.name = 'TimeoutError';
            console.error(`API Request Timeout [${method} ${endpoint}]:`, timeoutError);
            throw timeoutError;
        }
        if (callerSignal && callerSignal.aborted) {
            const abortError = new Error('请求已取消');
            abortError.name = 'AbortError';
            throw abortError;
        }
        if (error instanceof TypeError) {
            const networkError = new Error('无法连接后端服务，请确认后端已启动，或从 http://127.0.0.1:8000/app/ 打开应用');
            networkError.isNetworkError = true;
            throw networkError;
        }
        console.error(`API Request Error [${method} ${endpoint}]:`, error);
        throw error;
    } finally {
        clearTimeout(timer);
        if (callerSignal) {
            callerSignal.removeEventListener('abort', abortFromCaller);
        }
    }
}

/**
 * API 接口对象
 */
const API = {
    /**
     * 聊天相关 API
     */
    chat: {
        /**
         * 发送消息（流式响应）
         */
        async sendMessage(message, sessionId = null, options = {}) {
            const url = `${API_BASE_URL}/api/chat/send`;
            const authToken = localStorage.getItem('token') || '';
            const requestTokenGeneration = authTokenGeneration;
            const requestTokenFingerprint = calculateTokenFingerprint(authToken);
            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'text/event-stream',
                    ...(authToken ? { 'Authorization': `Bearer ${authToken}` } : {})
                },
                body: JSON.stringify({
                    message: message,
                    session_id: sessionId
                }),
                signal: options.signal
            });

            if (!response.ok) {
                const errorBody = await parseResponseBody(response);
                throw createApiError(
                    errorBody,
                    response.status,
                    requestTokenGeneration,
                    requestTokenFingerprint
                );
            }
            if (!response.body) {
                throw new Error('服务端未返回可读取的消息流');
            }

            return response.body;
        },

        /**
         * 获取聊天历史
         */
        async getHistory(sessionId = null, options = {}) {
            const endpoint = sessionId
                ? `/api/chat/history?session_id=${encodeURIComponent(sessionId)}`
                : '/api/chat/history';
            return await request('GET', endpoint, null, options);
        },

        /**
         * 删除聊天历史
         */
        async deleteHistory(sessionId, options = {}) {
            return await request('DELETE', `/api/chat/history/${encodeURIComponent(sessionId)}`, null, options);
        },

        /**
         * 获取会话列表
         */
        async getSessions(options = {}) {
            return await request('GET', '/api/chat/sessions', null, options);
        }
    },

    /**
     * 文章相关 API
     */
    articles: {
        /**
         * 获取文章列表
         */
        async getList(params = {}, options = {}) {
            const queryParams = new URLSearchParams();
            if (params.limit) queryParams.append('limit', params.limit);
            if (params.offset) queryParams.append('offset', params.offset);
            if (params.tag) queryParams.append('tag', params.tag);
            if (params.search) queryParams.append('search', params.search);

            const query = queryParams.toString();
            const endpoint = query ? `/api/articles/?${query}` : '/api/articles/';
            return await request('GET', endpoint, null, options);
        },

        /**
         * 获取单篇文章
         */
        async getById(articleId) {
            return await request('GET', `/api/articles/${articleId}`);
        },

        /**
         * 搜索文章
         */
        async search(query, limit = 10, options = {}) {
            return await request('GET', `/api/articles/search/${encodeURIComponent(query)}?limit=${limit}`, null, options);
        },

        /**
         * 同步文章
         */
        async sync() {
            return await request('POST', '/api/articles/sync');
        },

        /**
         * 获取同步状态
         */
        async getSyncStatus() {
            return await request('GET', '/api/articles/sync/status');
        },

        /**
         * 分析文章并创建时间轴
         */
        async analyze(articleId, createTimeline = true, options = {}) {
            return await request('POST', `/api/articles/analyze/${articleId}`, {
                create_timeline: createTimeline,
                timeline_color: "#4CAF50"
            }, { timeout: 180000, ...options });
        }
    },

    /**
     * 时间轴相关 API
     */
    timeline: {
        /**
         * 获取时间轴事件
         */
        async getEvents(params = {}, options = {}) {
            const queryParams = new URLSearchParams();
            if (params.start_date) queryParams.append('start_date', params.start_date);
            if (params.end_date) queryParams.append('end_date', params.end_date);
            if (params.source) queryParams.append('source', params.source);

            const query = queryParams.toString();
            const endpoint = query ? `/api/timeline/?${query}` : '/api/timeline/';
            return await request('GET', endpoint, null, options);
        },

        /**
         * 添加事件
         */
        async addEvent(event, options = {}) {
            return await request('POST', '/api/timeline/event', event, options);
        },

        /**
         * 更新事件
         */
        async updateEvent(eventId, event, options = {}) {
            return await request('PUT', `/api/timeline/event/${eventId}`, event, options);
        },

        /**
         * 删除事件
         */
        async deleteEvent(eventId, options = {}) {
            return await request('DELETE', `/api/timeline/event/${eventId}`, null, options);
        },

        /**
         * 获取今日事件
         */
        async getTodayEvents(options = {}) {
            return await request('GET', '/api/timeline/today', null, options);
        },

        /**
         * 导入 ICS 文件
         */
        async importICS(file, options = {}) {
            const formData = new FormData();
            formData.append('file', file);
            return await request('POST', '/api/timeline/import_ics', formData, options);
        },

        /**
         * 导出为 ICS 文件
         */
        async exportICS(options = {}) {
            return await request('GET', '/api/timeline/export_ics', null, options);
        }
    },

    /**
     * 设置相关 API
     */
    settings: {
        /**
         * 获取设置
         */
        async get() {
            return await request('GET', '/api/settings/');
        },

        /**
         * 更新设置
         */
        async update(settings, options = {}) {
            return await request('POST', '/api/settings/update', settings, options);
        },

        /**
         * 测试微信 API
         */
        async testWechatAPI() {
            return await request('GET', '/api/settings/test/wechat');
        },

        /**
         * 测试 AI API
         */
        async testAIAPI() {
            return await request('GET', '/api/settings/test/ai');
        }
    },

    /**
     * 认证相关 API
     */
    auth: {
        /**
         * 用户登录
         */
        async login(username, password) {
            const response = await request('POST', '/api/auth/login', {
                username: username,
                password: password
            }, { auth: false });
            validateLoginResponse(response);
            if (response.token) {
                this.saveToken(response.token);
            }
            return response;
        },

        /**
         * 用户注册（注册成功即登录）
         */
        async register(username, password, securityQuestion, securityAnswer) {
            const response = await request('POST', '/api/auth/register', {
                username,
                password,
                security_question: securityQuestion,
                security_answer: securityAnswer
            }, { auth: false });
            validateLoginResponse(response);
            if (response.token) {
                this.saveToken(response.token);
            }
            return response;
        },

        /**
         * 密保验证后重置密码
         */
        async forgotPassword(username, securityAnswer, newPassword) {
            return await request('POST', '/api/auth/forgot-password', {
                username,
                security_answer: securityAnswer,
                new_password: newPassword
            }, { auth: false });
        },

        /**
         * 查询密保问题（登录前可用）
         */
        async getSecurityQuestion(username) {
            return await request(
                'GET',
                `/api/auth/security-question?username=${encodeURIComponent(username)}`,
                null,
                { auth: false }
            );
        },

        /**
         * 获取当前用户信息
         */
        async getCurrentUser() {
            return await request('GET', '/api/auth/me');
        },

        /**
         * 用户登出
         */
        async logout() {
            const requestTokenGeneration = authTokenGeneration;
            try {
                return await request('POST', '/api/auth/logout');
            } finally {
                if (requestTokenGeneration === authTokenGeneration) {
                    this.clearToken();
                }
            }
        },

        /**
         * 刷新 token
         */
        async refreshToken() {
            const response = await request('POST', '/api/auth/refresh');
            if (response && response.token) {
                this.saveToken(response.token);
            }
            return response;
        },

        /**
         * 检查是否已登录（客户端方法）
         */
        isLoggedIn() {
            return Boolean(localStorage.getItem('token'));
        },

        /**
         * 保存 token（客户端方法）
         */
        saveToken(token) {
            if (typeof token === 'string' && token) {
                if (localStorage.getItem('token') !== token) {
                    localStorage.setItem('token', token);
                    authTokenGeneration++;
                }
            }
        },

        /**
         * 获取 token（客户端方法）
         */
        getToken() {
            return localStorage.getItem('token');
        },

        getTokenGeneration() {
            return authTokenGeneration;
        },

        getTokenFingerprint() {
            return getCurrentTokenFingerprint();
        },

        /**
         * 清除 token（客户端方法）
         */
        clearToken() {
            localStorage.removeItem('token');
            authTokenGeneration++;
        }
    },

    /**
     * 校园服务相关 API
     */
    campus: {
        /**
         * 获取我的课表
         */
        async getMySchedule() {
            return await request('GET', '/api/campus/schedule/my');
        },

        /**
         * 获取我的水电费
         */
        async getMyUtilities() {
            return await request('GET', '/api/campus/utilities/my');
        },

        /**
         * 获取运动设施状态
         */
        async getFacilities() {
            const response = await request('GET', '/api/campus/utilities');
            const sports = response && response.sports ? response.sports : {};
            const statusLabels = {
                open: '开放中',
                closed: '已关闭',
                maintenance: '维护中',
                unknown: '状态未知'
            };
            const facilities = [
                { key: 'gym_status', name: '健身房', icon: '🏃', time: '06:00-22:00' },
                { key: 'swimming_pool_status', name: '游泳池', icon: '🏊', time: '08:00-20:00' },
                { key: 'basketball_court_status', name: '篮球场', icon: '🏀', time: '全天开放' }
            ];
            return facilities.map(item => {
                const status = sports[item.key] || 'unknown';
                return {
                    name: item.name,
                    icon: item.icon,
                    available: status === 'open',
                    status,
                    time: statusLabels[status] || statusLabels.unknown
                };
            });
        },

        /**
         * 获取校历信息
         */
        async getCalendar() {
            return await request('GET', '/api/campus/calendar/academic');
        }
    },

    /**
     * 课表相关 API
     */
    schedule: {
        /** 导入为周课表，保留课程的实际教学周。 */
        async importICS(file, options = {}) {
            const formData = new FormData();
            formData.append('file', file);
            return await request('POST', '/api/schedule/import_ics', formData, options);
        },

        /**
         * 获取学期周数信息
         */
        async getWeeks() {
            return await request('GET', '/api/schedule/weeks');
        },

        /**
         * 获取课程列表
         */
        async getCourses(params = {}, options = {}) {
            const queryParams = new URLSearchParams();
            if (params.week) queryParams.append('week', params.week);
            const query = queryParams.toString();
            const endpoint = query ? `/api/schedule/courses?${query}` : '/api/schedule/courses';
            return await request('GET', endpoint, null, options);
        },

        /**
         * 添加自定义课程
         */
        async addCourse(course, options = {}) {
            return await request('POST', '/api/schedule/courses', course, options);
        },

        /**
         * 更新课程
         */
        async updateCourse(courseId, course, options = {}) {
            return await request('PUT', `/api/schedule/courses/${courseId}`, course, options);
        },

        /**
         * 删除课程
         */
        async deleteCourse(courseId, options = {}) {
            return await request('DELETE', `/api/schedule/courses/${courseId}`, null, options);
        }
    },

    /**
     * 健康检查
     */
    async healthCheck() {
        return await request('GET', '/health');
    },

    /**
     * AI 定时唤醒任务
     */
    wake: {
        async getTasks(options = {}) {
            return await request('GET', '/api/wake/tasks', null, options);
        },
        async addTask(prompt, schedule_time = '', options = {}) {
            return await request('POST', '/api/wake/tasks', { prompt, schedule_time }, options);
        },
        async deleteTask(taskId, options = {}) {
            return await request('DELETE', `/api/wake/tasks/${taskId}`, null, options);
        },
        async getSchedule(options = {}) {
            return await request('GET', '/api/wake/schedule', null, options);
        }
    },

    /**
     * 学校新闻
     */
    news: {
        async getList(forceRefresh = false) {
            const endpoint = forceRefresh ? '/api/news?force_refresh=true' : '/api/news';
            return await request('GET', endpoint);
        },
        async refresh() {
            return await request('POST', '/api/news/refresh');
        }
    }
};

/**
 * 工具函数
 */
const Utils = {
    escapeHTML(value) {
        return String(value == null ? '' : value).replace(/[&<>"']/g, char => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#39;'
        })[char]);
    },

    safeUrl(value) {
        if (value == null) return '';
        const candidate = String(value)
            .replace(/&amp;/gi, '&')
            .trim()
            .replace(/[\u0000-\u0020\u007F]+/g, '');
        if (!/^https?:\/\//i.test(candidate)) return '';
        try {
            const parsed = new URL(candidate);
            return parsed.protocol === 'http:' || parsed.protocol === 'https:'
                ? parsed.href
                : '';
        } catch (_) {
            return '';
        }
    },

    safeImageUrl(value) {
        if (value == null) return '';
        const candidate = String(value)
            .replace(/&amp;/gi, '&')
            .trim()
            .replace(/[\u0000-\u0020\u007F]+/g, '');
        if (candidate.startsWith('/static/') && !candidate.startsWith('//')) {
            try {
                const parsed = new URL(candidate, window.location.origin);
                return parsed.origin === window.location.origin
                    ? `${parsed.pathname}${parsed.search}${parsed.hash}`
                    : '';
            } catch (_) {
                return '';
            }
        }
        if (/^data:image\/(?:png|jpe?g|gif|webp|avif);base64,[a-z0-9+/=\s]+$/i.test(candidate)) {
            return candidate;
        }
        if (/^blob:/i.test(candidate)) {
            try {
                const parsed = new URL(candidate);
                return parsed.protocol === 'blob:' ? parsed.href : '';
            } catch (_) {
                return '';
            }
        }
        return this.safeUrl(candidate);
    },

    /**
     * 清理服务端 HTML。仅保留文章和 Markdown 所需的安全标签与属性。
     */
    sanitizeHTML(html, options = {}) {
        const input = String(html == null ? '' : html);
        if (typeof DOMParser === 'undefined') return this.escapeHTML(input);

        const doc = new DOMParser().parseFromString(`<body>${input}</body>`, 'text/html');
        const allowedTags = new Set([
            'a', 'blockquote', 'br', 'code', 'div', 'em', 'h1', 'h2', 'h3',
            'h4', 'h5', 'h6', 'hr', 'li', 'ol', 'p', 'pre', 'span',
            'strong', 'table', 'tbody', 'td', 'th', 'thead', 'tr', 'ul'
        ]);
        if (options.allowImages) allowedTags.add('img');
        const blockedTags = new Set([
            'script', 'style', 'iframe', 'object', 'embed', 'form', 'input',
            'textarea', 'select', 'button', 'svg', 'math', 'meta', 'link', 'base'
        ]);

        const comments = doc.createTreeWalker(doc.body, NodeFilter.SHOW_COMMENT);
        const nodesToRemove = [];
        while (comments.nextNode()) nodesToRemove.push(comments.currentNode);
        nodesToRemove.forEach(node => node.remove());

        for (const element of Array.from(doc.body.querySelectorAll('*'))) {
            const tag = element.tagName.toLowerCase();
            if (!allowedTags.has(tag)) {
                if (blockedTags.has(tag)) {
                    element.remove();
                } else {
                    element.replaceWith(...element.childNodes);
                }
                continue;
            }

            for (const attribute of Array.from(element.attributes)) {
                const name = attribute.name.toLowerCase();
                let allowed = name === 'title';
                if (tag === 'a' && (name === 'href' || name === 'target' || name === 'rel')) allowed = true;
                if (tag === 'code' && name === 'class') allowed = /^language-[\w-]+$/i.test(attribute.value);
                if (tag === 'td' || tag === 'th') {
                    allowed = allowed || ['colspan', 'rowspan'].includes(name);
                }
                if (tag === 'img') {
                    allowed = ['src', 'alt', 'title', 'width', 'height', 'loading'].includes(name);
                }
                if (!allowed) element.removeAttribute(attribute.name);
            }

            if (tag === 'a') {
                const href = this.safeUrl(element.getAttribute('href'));
                if (!href) {
                    element.removeAttribute('href');
                    element.removeAttribute('target');
                    element.removeAttribute('rel');
                } else {
                    element.setAttribute('href', href);
                    element.setAttribute('target', '_blank');
                    element.setAttribute('rel', 'noopener noreferrer');
                }
            }

            if (tag === 'img') {
                const src = this.safeImageUrl(element.getAttribute('src'));
                if (!src) {
                    element.remove();
                    continue;
                }
                element.setAttribute('src', src);
                element.setAttribute('loading', 'lazy');
                element.setAttribute('referrerpolicy', 'no-referrer');
            }
        }

        return doc.body.innerHTML;
    },

    parseDate(dateString) {
        if (dateString instanceof Date) {
            return Number.isNaN(dateString.getTime()) ? null : new Date(dateString);
        }
        if (dateString == null || dateString === '') return null;

        const value = String(dateString).trim();
        const dateOnly = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
        if (dateOnly) {
            const [, year, month, day] = dateOnly;
            return new Date(Number(year), Number(month) - 1, Number(day));
        }

        const normalized = value.includes(' ') && !value.includes('T')
            ? value.replace(' ', 'T')
            : value;
        const date = new Date(normalized);
        return Number.isNaN(date.getTime()) ? null : date;
    },

    /**
     * 格式化日期
     */
    formatDate(dateString) {
        if (!dateString) return '';
        const date = this.parseDate(dateString);
        if (!date) return '';
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    },

    /**
     * 格式化时间
     */
    formatTime(dateString) {
        if (!dateString) return '';
        const date = this.parseDate(dateString);
        if (!date) return '';
        const hours = String(date.getHours()).padStart(2, '0');
        const minutes = String(date.getMinutes()).padStart(2, '0');
        return `${hours}:${minutes}`;
    },

    /**
     * 格式化日期时间
     */
    formatDateTime(dateString) {
        if (!dateString) return '';
        return `${this.formatDate(dateString)} ${this.formatTime(dateString)}`;
    },

    /**
     * 格式化相对时间
     */
    formatRelativeTime(dateString) {
        if (!dateString) return '';
        const date = this.parseDate(dateString);
        if (!date) return '';
        const now = new Date();
        const diffMs = now - date;
        const diffMins = Math.floor(diffMs / 60000);
        const diffHours = Math.floor(diffMs / 3600000);
        const diffDays = Math.floor(diffMs / 86400000);

        if (diffMins < 1) return '刚刚';
        if (diffMins < 60) return `${diffMins}分钟前`;
        if (diffHours < 24) return `${diffHours}小时前`;
        if (diffDays < 7) return `${diffDays}天前`;
        return this.formatDate(dateString);
    },

    /**
     * 判断是否为今天
     */
    isToday(dateString) {
        if (!dateString) return false;
        const date = this.parseDate(dateString);
        if (!date) return false;
        const today = new Date();
        return date.getDate() === today.getDate() &&
               date.getMonth() === today.getMonth() &&
               date.getFullYear() === today.getFullYear();
    },

    /**
     * 生成 UUID
     */
    generateUUID() {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
            const r = Math.random() * 16 | 0;
            const v = c === 'x' ? r : (r & 0x3 | 0x8);
            return v.toString(16);
        });
    },

    /**
     * 获取当前时间
     */
    getCurrentTime() {
        return this.formatDateTime(new Date().toISOString());
    },

    /**
     * Markdown 转 HTML。先转义原始文本，再只生成受控的 HTML 标签。
     */
    markdownToHTML(markdown) {
        if (!markdown) return '';
        let source = String(markdown);
        const codeBlocks = [];
        source = source.replace(/```([\w-]*)\s*\n([\s\S]*?)```/g, (_, lang, code) => {
            const index = codeBlocks.length;
            const languageClass = lang ? ` class="language-${this.escapeHTML(lang)}"` : '';
            codeBlocks.push(`<pre><code${languageClass}>${this.escapeHTML(code.trim())}</code></pre>`);
            return `\n\uE000XD_CODE_${index}\uE001\n`;
        });

        const inline = text => {
            const inlineCodes = [];
            let value = String(text).replace(/`([^`\n]+)`/g, (_, code) => {
                const index = inlineCodes.length;
                inlineCodes.push(`<code>${this.escapeHTML(code)}</code>`);
                return `\uE100XD_INLINE_${index}\uE101`;
            });
            value = this.escapeHTML(value);
            value = value.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt, src) => {
                const safeSrc = this.safeImageUrl(src);
                if (!safeSrc) return alt;
                return `<img src="${this.escapeHTML(safeSrc)}" alt="${this.escapeHTML(alt)}" loading="lazy" referrerpolicy="no-referrer">`;
            });
            value = value.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, href) => {
                const safeHref = this.safeUrl(href);
                if (!safeHref) return label;
                return `<a href="${this.escapeHTML(safeHref)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
            });
            value = value.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
            value = value.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
            value = value.replace(/\uE100XD_INLINE_(\d+)\uE101/g, (_, index) => inlineCodes[Number(index)] || '');
            return value;
        };

        const lines = source.split(/\r?\n/);
        const out = [];
        let index = 0;

        while (index < lines.length) {
            const line = lines[index];
            const trimmed = line.trim();
            const codeMatch = trimmed.match(/^\uE000XD_CODE_(\d+)\uE001$/);
            if (!trimmed) {
                index++;
                continue;
            }
            if (codeMatch) {
                out.push(codeBlocks[Number(codeMatch[1])] || '');
                index++;
                continue;
            }
            if (/^ {0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
                out.push('<hr>');
                index++;
                continue;
            }
            const heading = line.match(/^\s*(#{1,6})\s+(.+)$/);
            if (heading) {
                const level = heading[1].length;
                out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
                index++;
                continue;
            }

            if (/^\s*\|.*\|\s*$/.test(line)) {
                const tableLines = [];
                while (index < lines.length && /^\s*\|.*\|\s*$/.test(lines[index])) {
                    tableLines.push(lines[index]);
                    index++;
                }
                const rows = tableLines.map(row => row.trim().replace(/^\||\|$/g, '').split('|').map(cell => cell.trim()));
                const bodyRows = rows.filter(row => !row.every(cell => /^:?-{3,}:?$/.test(cell)));
                if (bodyRows.length) {
                    const head = bodyRows.shift().map(cell => `<th>${inline(cell)}</th>`).join('');
                    const body = bodyRows.map(row => `<tr>${row.map(cell => `<td>${inline(cell)}</td>`).join('')}</tr>`).join('');
                    out.push(`<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`);
                }
                continue;
            }

            const unordered = line.match(/^\s*[-*+]\s+(.+)$/);
            const ordered = line.match(/^\s*\d+\.\s+(.+)$/);
            if (unordered || ordered) {
                const isOrdered = Boolean(ordered);
                const items = [];
                while (index < lines.length) {
                    const item = isOrdered
                        ? lines[index].match(/^\s*\d+\.\s+(.+)$/)
                        : lines[index].match(/^\s*[-*+]\s+(.+)$/);
                    if (!item) break;
                    items.push(`<li>${inline(item[1])}</li>`);
                    index++;
                }
                const tag = isOrdered ? 'ol' : 'ul';
                out.push(`<${tag}>${items.join('')}</${tag}>`);
                continue;
            }

            const paragraph = [line];
            index++;
            while (index < lines.length) {
                const next = lines[index];
                if (!next.trim() ||
                    /^\uE000XD_CODE_\d+\uE001$/.test(next.trim()) ||
                    /^\s*#{1,6}\s+/.test(next) ||
                    /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/.test(next) ||
                    /^\s*\|.*\|\s*$/.test(next) ||
                    /^\s*[-*+]\s+/.test(next) ||
                    /^\s*\d+\.\s+/.test(next)) {
                    break;
                }
                paragraph.push(next);
                index++;
            }
            out.push(`<p>${paragraph.map(inline).join('<br>')}</p>`);
        }

        return this.sanitizeHTML(out.join('\n'), { allowImages: true });
    }
};
