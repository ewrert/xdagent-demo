/**
 * XDAgent — 主应用
 * Vue 3 三栏布局：时间轴 | AI 对话 | 公众号文章
 */

const { createApp } = Vue;

let timelineRequestSeq = 0;
let timelineRequestController = null;
let articleRequestSeq = 0;
let articleRequestController = null;
let articleSearchTimer = null;
let scheduleRequestSeq = 0;
let scheduleRequestController = null;
let scheduleTimelineRequestSeq = 0;
let scheduleTimelineRequestController = null;
let chatStreamSeq = 0;
let activeChatController = null;
let bannerSequence = 0;
const ARTICLE_PAGE_SIZE = 100;
const TIMELINE_MIN_WIDTH = 240;
const TIMELINE_DEFAULT_WIDTH = 400;
const TIMELINE_MAX_WIDTH = 760;
const TIMELINE_VIEW_STORAGE_KEY = 'xdagent.timeline-view';
let timelineLayoutObserver = null;
let timelineDrag = null;
let timelineResizeFrame = null;
let accountEpoch = 0;
let authQuestionRequestSeq = 0;
let articleAnalysisRun = 0;
let articleAnalysisController = null;
const trackedPersonalControllers = new Set();
const CHAT_SESSION_OWNER_STORAGE_KEY = 'chat_session_owner';

function formatLocalDate(date) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0')
  ].join('-');
}

function localDateFromToday(dayOffset, hour = 9) {
  const date = new Date();
  date.setDate(date.getDate() + dayOffset);
  date.setHours(hour, 0, 0, 0);
  return `${formatLocalDate(date)}T${String(hour).padStart(2, '0')}:00:00`;
}

function createGuestTimelineEvents() {
  return [
    {
      id: 'guest_course',
      time: localDateFromToday(-1, 9),
      title: '演示：数据结构课',
      description: '游客演示数据，登录后可查看自己的日程',
      source: 'ics',
      color: '#2D84FF',
      duration: 100
    },
    {
      id: 'guest_lecture',
      time: localDateFromToday(0, 14),
      title: '演示：学术讲座',
      description: '游客演示数据，不会写入任何账号',
      source: 'ai',
      color: '#8A73D9',
      duration: 90
    },
    {
      id: 'guest_meeting',
      time: localDateFromToday(-3, 16),
      title: '演示：小组讨论',
      description: '登录后此区域展示当前账号的数据',
      source: 'manual',
      color: '#D97757',
      duration: 60
    }
  ];
}

function createGuestCourses() {
  return [
    {
      id: 'guest_discrete_math',
      name: '演示：离散数学',
      room: '教学楼 B-101',
      teacher: '示例教师',
      day_of_week: 1,
      start_time: '08:00',
      end_time: '09:40',
      week_numbers: Array.from({ length: 20 }, (_, index) => index + 1),
      color: '#2D84FF',
      source: 'course'
    },
    {
      id: 'guest_databases',
      name: '演示：数据库原理',
      room: '教学楼 C-302',
      teacher: '示例教师',
      day_of_week: 3,
      start_time: '10:00',
      end_time: '11:40',
      week_numbers: Array.from({ length: 20 }, (_, index) => index + 1),
      color: '#D97757',
      source: 'course'
    }
  ];
}

function trackPersonalController(controller) {
  trackedPersonalControllers.add(controller);
  return controller;
}

function releasePersonalController(controller) {
  trackedPersonalControllers.delete(controller);
}

function abortTrackedPersonalControllers() {
  for (const controller of trackedPersonalControllers) controller.abort();
  trackedPersonalControllers.clear();
}

function parseSseBlock(block) {
  const dataLines = [];
  for (const line of block.split('\n')) {
    if (!line.startsWith('data:')) continue;
    dataLines.push(line.slice(5).replace(/^ /, ''));
  }
  return dataLines.length ? dataLines.join('\n') : null;
}

function drainSseEvents(buffer) {
  const normalized = buffer.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const events = [];
  let boundary = normalized.indexOf('\n\n');
  let rest = normalized;
  while (boundary !== -1) {
    const data = parseSseBlock(rest.slice(0, boundary));
    if (data !== null) events.push(data);
    rest = rest.slice(boundary + 2);
    boundary = rest.indexOf('\n\n');
  }
  return { events, rest };
}

createApp({
  data() {
    return {
      // 时间轴
      timeline: {
        events: [],
        loading: false,
        error: null,
        typeFilter: 'all',
        dateFilter: {
          startDate: (() => {
            const date = new Date();
            date.setDate(date.getDate() - 90);
            return formatLocalDate(date);
          })(),
          endDate: (() => {
            const date = new Date();
            date.setDate(date.getDate() + 90);
            return formatLocalDate(date);
          })()
        }
      },

      // 聊天
      chatShortcuts: [
        { title: '竞赛报名', detail: '查看近期通知', icon: 'clipboard-text', prompt: '帮我整理近期的竞赛报名通知，包括报名条件和截止时间。' },
        { title: '校园讲座', detail: '整理学术活动', icon: 'school', prompt: '帮我整理本周的校园讲座和学术活动，包括时间、地点和参与方式。' },
        { title: '活动截止提醒', detail: '查看截止安排', icon: 'clock', prompt: '帮我找出近期即将截止的校园活动和报名事项，按截止时间排序。' }
      ],
      chat: {
        messages: [],
        inputMessage: '',
        isSending: false,
        isTyping: false,
        sessionId: Utils.generateUUID(),
        isRestoring: true
      },

      // 文章
      articles: {
        list: [],
        loading: false,
        searchQuery: '',
        error: null
      },

      // 文章分析状态（按 ID 记录）
      articleAnalyzing: {},
      articlePicker: {
        show: false, selectedIds: [], selectedArticles: [], running: false,
        completed: 0, total: 0, results: []
      },

      // 校园新闻
      showNews: false,
      newsList: [],
      newsLoading: false,
      newsError: null,

      // 课表
      schedule: {
        show: false,
        currentWeek: ScheduleData.getCurrentWeek(),
        totalWeeks: 20,
        semesterStart: '2026-02-23',
        showTimeline: false,
        timeSlots: ScheduleData.TIME_SLOTS,
        dayNames: ScheduleData.DAY_NAMES,
        courses: [],
        timelineEvents: [],
        loading: false,
        importing: false,
        error: null,
        weekRange: { start: '', end: '', dates: [] },
        expandedState: {}
      },

      // 添加课程弹窗
      showAddCourse: false,
      addCourseForm: {
        name: '',
        room: '',
        teacher: '',
        day_of_week: 1,
        start_time: '08:00',
        end_time: '09:40',
        week_numbers: []
      },

      // 设置
      settings: {
        wechat_api_key: '',
        ai_api_key: '',
        ai_api_url: '',
        ai_model: '',
        wake_schedule: '',
        campus_api_url: ''
      },

      // 唤醒任务
      wakeTasks: [],
      newWakeTaskPrompt: '',

      // UI 状态
      showSettings: false,
      showUserStatus: false,
      selectedArticle: null,
      banners: [],
      theme: 'light',
      mobilePanel: 'chat',
      timelineWidth: TIMELINE_DEFAULT_WIDTH,
      timelinePreferredWidth: TIMELINE_DEFAULT_WIDTH,
      timelineMaxWidth: TIMELINE_MAX_WIDTH,
      isResizingTimeline: false,
      isSavingCourse: false,
      isAddingWakeTask: false,
      isAnalyzingLatest: false,

      // 账号
      user: null,
      authModal: {
        show: false,
        tab: 'login',
        username: localStorage.getItem('xdagent.last-username') || '',
        password: '',
        confirmPassword: '',
        securityQuestion: '',
        securityAnswer: '',
        newPassword: '',
        error: '',
        errorCode: '',
        showPassword: false,
        loading: false
      },
      authQuestionLoading: false,
      securityQuestions: [
        '你最喜欢的老师是谁？',
        '你小学的名字是什么？',
        '你的出生城市是哪里？',
        '你最喜欢的食物是什么？',
        '你第一部手机的品牌是什么？',
        '你最好朋友的名字是什么？',
        '你最喜欢的电影是什么？',
        '你的宠物名字是什么？'
      ]
    };
  },

  computed: {
    selectedAnalysisArticles() {
      const articles = new Map([
        ...this.articlePicker.selectedArticles, ...this.articles.list
      ].map(article => [String(article.id), article]));
      return this.articlePicker.selectedIds.map(id => articles.get(id)).filter(Boolean);
    },

    hiddenSelectedArticleCount() {
      const visible = new Set(this.articles.list.map(article => String(article.id)));
      return this.selectedAnalysisArticles.filter(article => !visible.has(String(article.id))).length;
    },

    sortedTimelineEvents() {
      const events = this.timeline.events.filter(event => {
        if (this.timeline.typeFilter === 'all') return true;
        const isCourse = this.isCourseEvent(event.source);
        return this.timeline.typeFilter === 'course' ? isCourse : !isCourse;
      });
      events.sort((a, b) => {
        const aTime = Utils.parseDate(a.time);
        const bTime = Utils.parseDate(b.time);
        return (bTime ? bTime.getTime() : 0) - (aTime ? aTime.getTime() : 0);
      });
      return events;
    },

    scheduleTodayIndex() {
      const today = new Date();
      const todayStr = Utils.formatDate(today);
      const dates = this.schedule.weekRange.dates;
      if (!dates || dates.length === 0) return -1;
      return dates.indexOf(todayStr);
    },

    scheduleGrid() {
      const courseGroup = ScheduleData.groupCourses(
        this.schedule.courses,
        this.schedule.currentWeek
      );
      const timelineGroup = ScheduleData.groupTimelineEvents(
        this.schedule.timelineEvents,
        this.schedule.weekRange.dates
      );
      return ScheduleData.mergeGroups(courseGroup, timelineGroup);
    },

    scheduleVisibleSlots() {
      const hasOther = Object.values(this.scheduleGrid).some(day => day[0]?.length);
      return hasOther
        ? [...this.schedule.timeSlots, { id: 0, label: '其他时间', start: '', end: '' }]
        : this.schedule.timeSlots;
    },

    scheduleHasEvents() {
      return Object.values(this.scheduleGrid).some(day =>
        Object.values(day).some(events => events.length)
      );
    }
  },

  watch: {
    'timeline.events': {
      handler() {
        if (this.schedule.show && this.schedule.showTimeline) {
          this.loadScheduleTimelineEvents();
        }
      },
      deep: true
    },

    'schedule.currentWeek': async function() {
      this.schedule.expandedState = {};
      this.updateWeekRange();
      if (this.user) {
        try {
          localStorage.setItem(`xdagent.schedule-week.${this.user.username}`, String(this.schedule.currentWeek));
        } catch (_) {
          // 周次偏好保存失败不影响课表显示。
        }
      }
      if (this.schedule.show && !this.schedule.importing) {
        await this.loadScheduleData();
      }
    },

    theme: function() {
      this.applyTheme();
    }
  },

  async mounted() {
    window.__app = this;
    window.addEventListener('storage', this.onAuthStorageChange);
    this.initTheme();
    this.initTimelineView();
    if (API.auth.isLoggedIn()) {
      await this.initUserSession();
    } else {
      this.enterGuestMode();
    }
    this.loadSettings();
  },

  beforeUnmount() {
    this.stopArticleAnalysis();
    window.removeEventListener('storage', this.onAuthStorageChange);
    this.finishTimelineResize();
    if (timelineLayoutObserver) timelineLayoutObserver.disconnect();
    timelineLayoutObserver = null;
    chatStreamSeq++;
    if (activeChatController) activeChatController.abort();
    if (timelineRequestController) timelineRequestController.abort();
    if (articleRequestController) articleRequestController.abort();
    if (scheduleRequestController) scheduleRequestController.abort();
    if (scheduleTimelineRequestController) scheduleTimelineRequestController.abort();
    if (articleSearchTimer) clearTimeout(articleSearchTimer);
    abortTrackedPersonalControllers();
  },

  methods: {
    // ===================== 账号与数据隔离 =====================

    captureAccountContext() {
      return {
        epoch: accountEpoch,
        tokenFingerprint: API.auth.getTokenFingerprint(),
        username: this.user?.username || ''
      };
    },

    isAccountContextCurrent(context) {
      return Boolean(
        context &&
        context.epoch === accountEpoch &&
        context.tokenFingerprint === API.auth.getTokenFingerprint() &&
        API.auth.getToken() &&
        this.user &&
        this.user.username === context.username
      );
    },

    invalidateAccountRequests() {
      this.closeArticlePicker();
      this.articlePicker.selectedIds = [];
      this.articlePicker.selectedArticles = [];
      this.articlePicker.results = [];
      accountEpoch++;
      timelineRequestSeq++;
      scheduleRequestSeq++;
      scheduleTimelineRequestSeq++;
      chatStreamSeq++;
      if (timelineRequestController) timelineRequestController.abort();
      if (scheduleRequestController) scheduleRequestController.abort();
      if (scheduleTimelineRequestController) scheduleTimelineRequestController.abort();
      if (activeChatController) activeChatController.abort();
      abortTrackedPersonalControllers();
      timelineRequestController = null;
      scheduleRequestController = null;
      scheduleTimelineRequestController = null;
      activeChatController = null;
      this.timeline.loading = false;
      this.schedule.loading = false;
      this.schedule.importing = false;
      this.chat.isSending = false;
      this.chat.isTyping = false;
      this.isSavingCourse = false;
      this.isAddingWakeTask = false;
      this.isAnalyzingLatest = false;
      this.articleAnalyzing = {};
      this.banners = [];
    },

    resetPersonalViewState({ clearChatSession = true } = {}) {
      this.timeline.events = [];
      this.timeline.error = null;
      this.schedule.courses = [];
      this.schedule.timelineEvents = [];
      this.schedule.error = null;
      this.schedule.expandedState = {};
      this.schedule.show = false;
      this.schedule.showTimeline = false;
      this.wakeTasks = [];
      this.newWakeTaskPrompt = '';
      this.chat.messages = [];
      this.chat.inputMessage = '';
      this.chat.sessionId = Utils.generateUUID();
      this.chat.isRestoring = false;
      this.selectedArticle = null;
      this.showAddCourse = false;
      this.showUserStatus = false;
      if (clearChatSession) {
        localStorage.removeItem('chat_session_id');
        localStorage.removeItem(CHAT_SESSION_OWNER_STORAGE_KEY);
      }
    },

    normalizeUser(user) {
      return {
        username: String(user?.username || ''),
        created_at: user?.created_at || '',
        last_login: user?.last_login || ''
      };
    },

    async initUserSession() {
      const tokenAtStart = API.auth.getToken() || '';
      const tokenFingerprintAtStart = API.auth.getTokenFingerprint();
      if (!tokenAtStart) {
        this.enterGuestMode();
        return;
      }

      try {
        const info = await API.auth.getCurrentUser();
        if (!API.auth.getToken() ||
            tokenFingerprintAtStart !== API.auth.getTokenFingerprint()) return;
        await this.activateAuthenticatedUser(info, {
          freshSession: false,
          welcome: null
        });
      } catch (error) {
        if (tokenFingerprintAtStart !== API.auth.getTokenFingerprint()) return;
        if (error.isAuthError) {
          this.handleAuthError(error, { showLogin: false });
          return;
        }
        if (error.error_code === 'INVALID_ACCOUNT_RESPONSE') {
          API.auth.clearToken();
          this.enterGuestMode({
            clearToken: false,
            notice: '账号状态无效，已切换到游客演示模式'
          });
          return;
        }
        console.error('恢复登录态失败:', error);
        this.enterGuestMode({
          clearToken: false,
          notice: '暂时无法连接账号服务，当前显示游客演示数据'
        });
      }
    },

    async activateAuthenticatedUser(user, { freshSession = true, welcome = null } = {}) {
      const normalizedUser = this.normalizeUser(user);
      if (!normalizedUser.username || !API.auth.getToken()) {
        const error = new Error('账号服务返回了无效的登录状态');
        error.error_code = 'INVALID_ACCOUNT_RESPONSE';
        throw error;
      }
      this.invalidateAccountRequests();
      this.user = normalizedUser;
      this.resetPersonalViewState({ clearChatSession: freshSession });
      this.chat.isRestoring = true;
      this.authModal.show = false;
      this.showUserStatus = false;
      if (welcome) this.showBanner('success', welcome.title, welcome.message);
      await this.loadUserData();
    },

    enterGuestMode({
      clearToken = true,
      showLogin = false,
      notice = ''
    } = {}) {
      this.invalidateAccountRequests();
      if (clearToken) API.auth.clearToken();
      this.user = null;
      this.resetPersonalViewState();
      this.timeline.events = createGuestTimelineEvents();
      this.schedule.courses = createGuestCourses();
      this.updateWeekRange();
      this.timeline.error = null;
      this.chat.isRestoring = false;
      this.showSettings = false;
      if (notice) this.showBanner('info', '游客模式', notice);
      this.loadArticles();
      if (showLogin) this.openAuthModal('login');
    },

    async loadUserData() {
      if (!this.user) return;
      let savedWeek = 0;
      try {
        savedWeek = Number(localStorage.getItem(`xdagent.schedule-week.${this.user.username}`));
      } catch (_) {
        // 未保存周次时沿用当前教学周。
      }
      this.schedule.currentWeek = Number.isInteger(savedWeek) && savedWeek >= 1 && savedWeek <= this.schedule.totalWeeks
        ? savedWeek
        : ScheduleData.getCurrentWeek(this.schedule.semesterStart);
      this.updateWeekRange();
      await Promise.all([
        this.loadTimeline(),
        this.loadScheduleData(),
        this.loadWakeTasks(),
        this.restoreChatSession(),
        this.loadArticles()
      ]);
    },

    openAuthModal(tab = 'login') {
      if (this.user) {
        this.showUserStatus = true;
        return;
      }
      this.showSettings = false;
      this.showAddCourse = false;
      this.showUserStatus = false;
      this.selectedArticle = null;
      this.authModal.show = true;
      this.authModal.tab = ['login', 'register', 'forgot'].includes(tab) ? tab : 'login';
      this.authModal.error = '';
      this.authModal.errorCode = '';
      this.authModal.showPassword = false;
      authQuestionRequestSeq++;
      this.authQuestionLoading = false;
    },

    switchAuthTab(tab) {
      if (!['login', 'register', 'forgot'].includes(tab)) return;
      if (this.authModal.loading) return;
      authQuestionRequestSeq++;
      this.authQuestionLoading = false;
      this.authModal.tab = tab;
      this.authModal.error = '';
      this.authModal.errorCode = '';
      this.authModal.showPassword = false;
      this.authModal.password = '';
      this.authModal.confirmPassword = '';
      this.authModal.securityAnswer = '';
      this.authModal.newPassword = '';
      if (tab !== 'forgot') this.authModal.securityQuestion = '';
    },

    closeAuthModal() {
      if (this.authModal.loading) return;
      authQuestionRequestSeq++;
      this.authQuestionLoading = false;
      this.authModal.show = false;
      this.authModal.error = '';
      this.authModal.errorCode = '';
      this.authModal.showPassword = false;
      this.authModal.password = '';
      this.authModal.confirmPassword = '';
      this.authModal.securityAnswer = '';
      this.authModal.newPassword = '';
    },

    openUserStatus() {
      if (this.requireLogin()) this.showUserStatus = true;
    },

    requireLogin(message = '登录后才能保存或发送个人数据') {
      if (this.user && API.auth.getToken()) return true;
      if (this.user) {
        this.user = null;
        this.enterGuestMode();
      }
      this.showBanner('info', '请先登录', message);
      this.openAuthModal('login');
      return false;
    },

    isCurrentAuthError(error) {
      if (!error?.isAuthError) return false;
      return error.authTokenGeneration === API.auth.getTokenGeneration() &&
        error.authTokenFingerprint === API.auth.getTokenFingerprint();
    },

    handleAuthError(error, { showLogin = true } = {}) {
      if (!this.isCurrentAuthError(error)) return false;
      API.auth.clearToken();
      this.enterGuestMode({
        clearToken: true,
        showLogin,
        notice: '登录状态已失效，请重新登录'
      });
      return true;
    },

    onAuthStorageChange(event) {
      if (event.key !== 'token' && event.key !== null) return;
      this.enterGuestMode({
        clearToken: false,
        notice: API.auth.isLoggedIn()
          ? '检测到账号会话变化，正在重新加载'
          : '账号会话已在其他页面退出'
      });
      if (API.auth.isLoggedIn()) this.initUserSession();
    },

    async doLogin() {
      if (this.authModal.loading) return;
      const username = this.authModal.username.trim();
      if (!username || !this.authModal.password) {
        this.authModal.error = '请输入用户名和密码';
        return;
      }
      this.authModal.loading = true;
      this.authModal.error = '';
      this.authModal.errorCode = '';
      API.auth.clearToken();
      try {
        const response = await API.auth.login(username, this.authModal.password);
        localStorage.setItem('xdagent.last-username', response.user.username);
        this.authModal.password = '';
        await this.activateAuthenticatedUser(response.user, {
          freshSession: true,
          welcome: {
            title: '欢迎回来',
            message: `已登录：${response.user.username}`
          }
        });
      } catch (error) {
        if (error.error_code === 'INVALID_ACCOUNT_RESPONSE') {
          API.auth.clearToken();
        }
        this.authModal.show = true;
        this.authModal.errorCode = error.error_code || '';
        this.authModal.error = error.error_code === 'USER_NOT_FOUND'
          ? '该用户名未注册，请先注册'
          : (error.message || '登录失败');
      } finally {
        this.authModal.loading = false;
      }
    },

    async doRegister() {
      if (this.authModal.loading) return;
      const username = this.authModal.username.trim();
      const form = this.authModal;
      if (!/^[A-Za-z0-9_]{3,20}$/.test(username)) {
        form.error = '用户名需为 3~20 位字母、数字或下划线';
        return;
      }
      if (form.password.length < 6) {
        form.error = '密码至少需要 6 位';
        return;
      }
      if (form.password !== form.confirmPassword) {
        form.error = '两次输入的密码不一致';
        return;
      }
      if (!form.securityQuestion || form.securityAnswer.trim().length < 2) {
        form.error = '请选择密保问题，答案至少需要 2 个字符';
        return;
      }
      form.loading = true;
      form.error = '';
      API.auth.clearToken();
      try {
        const response = await API.auth.register(
          username,
          form.password,
          form.securityQuestion,
          form.securityAnswer.trim()
        );
        localStorage.setItem('xdagent.last-username', response.user.username);
        form.password = '';
        form.confirmPassword = '';
        form.securityAnswer = '';
        await this.activateAuthenticatedUser(response.user, {
          freshSession: true,
          welcome: {
            title: '注册成功',
            message: `欢迎加入 XDAgent：${response.user.username}`
          }
        });
      } catch (error) {
        if (error.error_code === 'INVALID_ACCOUNT_RESPONSE') {
          API.auth.clearToken();
        }
        form.error = error.message || '注册失败';
      } finally {
        form.loading = false;
      }
    },

    async loadSecurityQuestion() {
      const username = this.authModal.username.trim();
      if (!username) return;
      const requestId = ++authQuestionRequestSeq;
      this.authQuestionLoading = true;
      this.authModal.error = '';
      this.authModal.securityQuestion = '';
      try {
        const response = await API.auth.getSecurityQuestion(username);
        if (requestId !== authQuestionRequestSeq ||
            username !== this.authModal.username.trim()) return;
        this.authModal.securityQuestion = response.security_question || '';
      } catch (error) {
        if (requestId !== authQuestionRequestSeq ||
            username !== this.authModal.username.trim()) return;
        this.authModal.securityQuestion = '';
        this.authModal.error = error.error_code === 'USER_NOT_FOUND'
          ? '该用户名未注册'
          : (error.message || '无法加载密保问题');
      } finally {
        if (requestId === authQuestionRequestSeq) {
          this.authQuestionLoading = false;
        }
      }
    },

    async doForgotPassword() {
      if (this.authModal.loading) return;
      const form = this.authModal;
      const username = form.username.trim();
      if (!username || !form.securityQuestion) {
        form.error = '请先输入用户名并加载密保问题';
        return;
      }
      if (!form.securityAnswer.trim()) {
        form.error = '请输入密保答案';
        return;
      }
      if (form.newPassword.length < 6) {
        form.error = '新密码至少需要 6 位';
        return;
      }
      form.loading = true;
      form.error = '';
      try {
        await API.auth.forgotPassword(
          username,
          form.securityAnswer.trim(),
          form.newPassword
        );
        form.securityAnswer = '';
        form.newPassword = '';
        form.securityQuestion = '';
        form.password = '';
        form.tab = 'login';
        this.showBanner('success', '密码已重置', '请使用新密码登录');
      } catch (error) {
        form.error = error.error_code === 'WRONG_SECURITY_ANSWER'
          ? '密保答案错误'
          : (error.message || '重置失败');
      } finally {
        form.loading = false;
      }
    },

    async logout() {
      if (!this.user) return;
      this.invalidateAccountRequests();
      this.showUserStatus = false;
      const logoutRequest = API.auth.logout().catch(error => {
        console.error('退出登录请求失败，已清理本地账号状态:', error);
      });
      this.enterGuestMode();
      this.showBanner('info', '已退出登录', '当前为游客演示模式');
      await logoutRequest;
    },

    formatAccountDate(value) {
      return value ? Utils.formatDateTime(value) : '暂无记录';
    },

    // ===================== 时间轴显示与宽度 =====================

    initTimelineView() {
      try {
        const saved = JSON.parse(localStorage.getItem(TIMELINE_VIEW_STORAGE_KEY));
        if (saved && ['all', 'activity', 'course'].includes(saved.typeFilter)) {
          this.timeline.typeFilter = saved.typeFilter;
        }
        if (saved && Number.isFinite(saved.width)) {
          this.timelineWidth = Math.min(TIMELINE_MAX_WIDTH, Math.max(TIMELINE_MIN_WIDTH, saved.width));
        }
      } catch (_) {
        // 浏览器禁用存储或旧数据损坏时，使用默认显示。
      }
      this.timelinePreferredWidth = this.timelineWidth;
      this.updateTimelineWidthBounds();
      timelineLayoutObserver = new ResizeObserver(() => this.updateTimelineWidthBounds());
      timelineLayoutObserver.observe(this.$refs.mainLayout);
    },

    saveTimelineView() {
      try {
        localStorage.setItem(TIMELINE_VIEW_STORAGE_KEY, JSON.stringify({
          typeFilter: this.timeline.typeFilter,
          width: this.timelinePreferredWidth
        }));
      } catch (_) {
        // 无存储权限时，筛选与拖动仍可正常使用。
      }
    },

    setTimelineTypeFilter(type) {
      if (!['all', 'activity', 'course'].includes(type)) return;
      this.timeline.typeFilter = type;
      this.saveTimelineView();
    },

    updateTimelineWidthBounds() {
      if (window.matchMedia('(max-width: 900px)').matches) {
        this.finishTimelineResize();
        return;
      }
      const layout = this.$refs.mainLayout;
      // v-cloak 在挂载完成前仍隐藏根节点，等观察器拿到真实尺寸后再收紧宽度。
      if (!layout || !layout.clientWidth) return;
      const articles = layout.querySelector('.panel--articles');
      // 给对话区保留至少 320px，另预留 10px 拖动手柄。
      this.timelineMaxWidth = Math.floor(Math.max(TIMELINE_MIN_WIDTH, Math.min(
        TIMELINE_MAX_WIDTH, layout.clientWidth - articles.getBoundingClientRect().width - 330
      )));
      this.setTimelineWidth(this.timelinePreferredWidth, false);
    },

    setTimelineWidth(width, persist = true) {
      const value = Number(width);
      if (!Number.isFinite(value)) return;
      this.timelineWidth = Math.round(Math.min(this.timelineMaxWidth, Math.max(TIMELINE_MIN_WIDTH, value)));
      if (persist) {
        this.timelinePreferredWidth = this.timelineWidth;
        this.saveTimelineView();
      }
    },

    startTimelineResize(event) {
      if (event.button !== 0 || timelineDrag || window.matchMedia('(max-width: 900px)').matches) return;
      event.preventDefault();
      this.updateTimelineWidthBounds();
      timelineDrag = {
        pointerId: event.pointerId,
        target: event.currentTarget,
        startX: event.clientX,
        startWidth: this.timelineWidth,
        width: this.timelineWidth
      };
      event.currentTarget.setPointerCapture(event.pointerId);
      this.isResizingTimeline = true;
    },

    moveTimelineResize(event) {
      if (!timelineDrag || event.pointerId !== timelineDrag.pointerId) return;
      timelineDrag.width = timelineDrag.startWidth + event.clientX - timelineDrag.startX;
      if (timelineResizeFrame !== null) return;
      timelineResizeFrame = requestAnimationFrame(() => {
        timelineResizeFrame = null;
        if (timelineDrag) this.setTimelineWidth(timelineDrag.width, false);
      });
    },

    finishTimelineResize(event) {
      if (!timelineDrag || (event && event.pointerId !== timelineDrag.pointerId)) return;
      const drag = timelineDrag;
      timelineDrag = null;
      if (timelineResizeFrame !== null) cancelAnimationFrame(timelineResizeFrame);
      timelineResizeFrame = null;
      this.setTimelineWidth(drag.width);
      this.isResizingTimeline = false;
      if (drag.target.hasPointerCapture(drag.pointerId)) drag.target.releasePointerCapture(drag.pointerId);
    },

    onTimelineResizeKeydown(event) {
      const step = event.shiftKey ? 40 : 16;
      const widths = {
        ArrowLeft: this.timelineWidth - step,
        ArrowRight: this.timelineWidth + step,
        Home: TIMELINE_MIN_WIDTH,
        End: this.timelineMaxWidth,
        Enter: TIMELINE_DEFAULT_WIDTH
      };
      if (!Object.hasOwn(widths, event.key)) return;
      event.preventDefault();
      this.setTimelineWidth(widths[event.key]);
    },

    // ===================== 主题切换 =====================

    initTheme() {
      const saved = localStorage.getItem('theme');
      if (saved === 'dark' || saved === 'light') {
        this.theme = saved;
      }
      this.applyTheme();
    },

    toggleTheme() {
      this.theme = this.theme === 'light' ? 'dark' : 'light';
      localStorage.setItem('theme', this.theme);
      this.applyTheme();
    },

    applyTheme() {
      document.documentElement.setAttribute('data-theme', this.theme);
      if (this.theme === 'dark') {
        document.body.classList.add('dark-mode');
      } else {
        document.body.classList.remove('dark-mode');
      }
    },

    triggerICSImport() {
      if (!this.requireLogin('登录后才能导入个人课表')) return;
      if (this.schedule.importing) return;
      const input = this.$refs.icsFileInput;
      if (input) input.click();
    },

    // ===================== 通知系统 =====================

    showBanner(type, title, message, duration = 4000) {
      const banner = { id: ++bannerSequence, type, title, message };
      this.banners.push(banner);
      if (duration > 0) {
        setTimeout(() => {
          this.dismissBanner(banner.id);
        }, duration);
      }
      return banner.id;
    },

    dismissBanner(bannerId) {
      const index = this.banners.findIndex(banner => banner.id === bannerId);
      if (index !== -1) this.banners.splice(index, 1);
    },

    // ===================== 数据加载 =====================

    async loadAllData() {
      await Promise.all([
        this.loadTimeline(),
        this.loadArticles()
      ]);
    },

    // ===================== 时间轴 =====================

    async loadTimeline(params = {}) {
      if (!this.user) return;
      const requestId = ++timelineRequestSeq;
      if (timelineRequestController) timelineRequestController.abort();
      timelineRequestController = null;
      const startDate = this.timeline.dateFilter.startDate;
      const endDate = this.timeline.dateFilter.endDate;
      if (startDate && endDate && startDate > endDate) {
        this.timeline.loading = false;
        this.timeline.error = '开始日期不能晚于结束日期';
        return;
      }

      timelineRequestController = trackPersonalController(new AbortController());
      const requestController = timelineRequestController;
      const accountContext = this.captureAccountContext();
      this.timeline.loading = true;
      this.timeline.error = null;
      try {
        // 合并日期筛选条件
        const query = { ...params };
        if (startDate) {
          query.start_date = `${startDate}T00:00:00`;
        }
        if (endDate) {
          query.end_date = `${endDate}T23:59:59`;
        }
        const events = await API.timeline.getEvents(query, {
          signal: requestController.signal
        });
        if (requestId !== timelineRequestSeq ||
            !this.isAccountContextCurrent(accountContext)) return;
        this.timeline.events = events || [];
      } catch (error) {
        if (error.name === 'AbortError' ||
            requestId !== timelineRequestSeq ||
            !this.isAccountContextCurrent(accountContext)) return;
        if (this.handleAuthError(error)) return;
        console.error('加载时间轴失败:', error);
        if (requestId === timelineRequestSeq &&
            this.isAccountContextCurrent(accountContext)) {
          this.timeline.error = error.message;
        }
      } finally {
        releasePersonalController(requestController);
        if (requestId === timelineRequestSeq) {
          this.timeline.loading = false;
          if (timelineRequestController === requestController) {
            timelineRequestController = null;
          }
        }
      }
    },

    async refreshTimeline() {
      await this.loadTimeline();
    },

    async applyDateFilter() {
      await this.loadTimeline();
    },

    clearDateFilter() {
      this.timeline.dateFilter.startDate = '';
      this.timeline.dateFilter.endDate = '';
      this.refreshTimeline();
    },

    async deleteEvent(eventId) {
      if (!this.requireLogin()) return;
      const accountContext = this.captureAccountContext();
      const controller = trackPersonalController(new AbortController());
      try {
        await API.timeline.deleteEvent(eventId, { signal: controller.signal });
        if (!this.isAccountContextCurrent(accountContext)) return;
        this.showBanner('success', '事件已删除');
        await this.loadTimeline();
      } catch (error) {
        if (error.name === 'AbortError' ||
            !this.isAccountContextCurrent(accountContext)) return;
        if (this.handleAuthError(error)) return;
        console.error('删除事件失败:', error);
        this.showBanner('error', '删除失败', error.message);
      } finally {
        releasePersonalController(controller);
      }
    },

    async importICS(event) {
      // 时间轴和课表的上传入口使用同一套写入与显示流程。
      return this.importScheduleICS(event);
    },

    isToday(dateString) {
      return Utils.isToday(dateString);
    },

    formatTime(dateString) {
      if (!dateString) return '';
      const date = new Date(dateString);
      const now = new Date();
      if (Utils.isToday(dateString)) {
        return `今天 ${Utils.formatTime(dateString)}`;
      }
      const yesterday = new Date(now);
      yesterday.setDate(yesterday.getDate() - 1);
      if (
        date.getDate() === yesterday.getDate() &&
        date.getMonth() === yesterday.getMonth() &&
        date.getFullYear() === yesterday.getFullYear()
      ) {
        return `昨天 ${Utils.formatTime(dateString)}`;
      }
      return Utils.formatDateTime(dateString);
    },

    formatSource(source) {
      const map = { ics: '课程', ai: 'AI 分析', manual: '手动', wechat: '公众号' };
      return map[source] || source;
    },

    sourceColor(source) {
      const map = { ics: '#2D84FF', ai: '#438FFF', manual: '#FF762F', wechat: '#8A73D9' };
      return map[source] || '#647493';
    },

    isCourseEvent(source) {
      return source === 'ics';
    },

    // ===================== 聊天 =====================

    useChatPrompt(prompt) {
      if (this.chat.isRestoring || this.chat.isSending) return;
      this.chat.inputMessage = prompt;
      this.$nextTick(() => {
        this.$refs.chatInput?.focus();
        this.autoResizeTextarea();
      });
    },

    async sendMessage() {
      if (!this.requireLogin('登录后才能发送消息并保存聊天记录')) return;
      const message = this.chat.inputMessage.trim();
      if (!message || this.chat.isSending || this.chat.isRestoring) return;

      const accountContext = this.captureAccountContext();
      this.chat.messages.push({
        role: 'user',
        content: message,
        timestamp: new Date().toISOString(),
        id: Utils.generateUUID()
      });
      this.chat.inputMessage = '';
      this.chat.isSending = true;
      this.chat.isTyping = true;
      const streamId = ++chatStreamSeq;
      const controller = trackPersonalController(new AbortController());
      activeChatController = controller;
      let assistantIndex = -1;
      let chunkCount = 0;
      let lastToolAction = '';
      this.saveChatSession();

      this.$nextTick(() => this.scrollChatToBottom());

      const assertStreamCurrent = () => {
        if (streamId !== chatStreamSeq ||
            !this.isAccountContextCurrent(accountContext)) {
          const error = new Error('请求已取消');
          error.name = 'AbortError';
          throw error;
        }
      };

      const ensureAssistantMessage = () => {
        assertStreamCurrent();
        if (assistantIndex === -1) {
          this.chat.messages.push({
            role: 'assistant',
            content: '',
            timestamp: new Date().toISOString(),
            id: Utils.generateUUID(),
            isThinking: false
          });
          assistantIndex = this.chat.messages.length - 1;
        }
        return this.chat.messages[assistantIndex];
      };

      const updateAssistantMessage = patch => {
        assertStreamCurrent();
        ensureAssistantMessage();
        this.chat.messages[assistantIndex] = {
          ...this.chat.messages[assistantIndex],
          ...patch
        };
      };

      const handleStreamEvent = async rawEvent => {
        assertStreamCurrent();
        let data;
        try {
          data = JSON.parse(rawEvent);
        } catch (error) {
          throw new Error('服务端返回了无效的流式数据');
        }

        if (data.error) {
          throw new Error(data.error);
        }

        if (data.tool_call) {
          const actionNames = {
            search_articles: '搜索文章',
            search_handbook: '查询手册',
            add_timeline_event: '添加事件',
            add_schedule_course: '创建课表',
            get_timeline: '获取时间轴',
            search_news: '搜索校园新闻'
          };
          lastToolAction = data.tool_call;
          const name = actionNames[data.tool_call] || data.tool_call;
          const query = data.query ? `: ${data.query}` : '';
          updateAssistantMessage({
            content: `正在${name}${query}...`,
            isThinking: true
          });
          this.chat.isTyping = false;
          this.$nextTick(() => this.scrollChatToBottom());
          return false;
        }

        if (data.tool_result !== undefined) {
          if (
            data.success !== false
            && ['add_timeline_event', 'add_schedule_course'].includes(lastToolAction)
          ) {
            await this.loadTimeline();
            if (lastToolAction === 'add_schedule_course' && this.schedule.show) {
              this.updateWeekRange();
              await this.loadScheduleData();
            }
          }
          updateAssistantMessage({
            content: data.success === false
              ? '工具执行失败，正在整理原因...'
              : '工具执行完成，正在整理结果...',
            isThinking: true
          });
          this.$nextTick(() => this.scrollChatToBottom());
          return false;
        }

        if (data.chunk) {
          const current = ensureAssistantMessage();
          updateAssistantMessage({
            content: current.isThinking
              ? data.chunk
              : current.content + data.chunk,
            isThinking: false
          });
          this.chat.isTyping = false;
          chunkCount++;
          if (chunkCount % 8 === 0) {
            await new Promise(resolve => setTimeout(resolve, 0));
          }
          this.$nextTick(() => this.scrollChatToBottom());
          return false;
        }

        if (data.done) {
          if (assistantIndex !== -1 && this.chat.messages[assistantIndex].isThinking) {
            updateAssistantMessage({ isThinking: false });
          }
          return true;
        }

        return false;
      };

      try {
        const stream = await API.chat.sendMessage(message, this.chat.sessionId, {
          signal: controller.signal
        });
        const reader = stream.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let receivedDone = false;

        while (!receivedDone) {
          const { done, value } = await reader.read();
            assertStreamCurrent();
          if (done) {
            buffer += decoder.decode();
          } else {
            buffer += decoder.decode(value, { stream: true });
          }

          const drained = drainSseEvents(buffer);
          buffer = drained.rest;

          for (const eventData of drained.events) {
              assertStreamCurrent();
            if (await handleStreamEvent(eventData)) {
              receivedDone = true;
              break;
            }
          }

          if (done) {
            break;
          }
          if (receivedDone) {
            await reader.cancel().catch(() => {});
          }
        }

        if (!receivedDone) {
          throw new Error('消息流意外断开，请重试');
        }
        if (assistantIndex === -1) {
          updateAssistantMessage({
            content: '服务端未返回回复内容',
            isThinking: false
          });
        }

        // 保存会话ID用于刷新后恢复
          assertStreamCurrent();
          this.saveChatSession();
      } catch (error) {
        if (streamId !== chatStreamSeq) return;
          if (!this.isAccountContextCurrent(accountContext)) return;
          if (this.handleAuthError(error)) return;
        if (error.name !== 'AbortError') {
          console.error('发送消息失败:', error);
        }
        this.chat.isTyping = false;
        if (error.name !== 'AbortError') {
          const errorText = `抱歉，发生了错误：${error.message}`;
          if (assistantIndex === -1) {
            updateAssistantMessage({ content: errorText, isThinking: false });
          } else {
            const partial = this.chat.messages[assistantIndex].content;
            updateAssistantMessage({
              content: partial ? `${partial}\n\n**回复中断：** ${error.message}` : errorText,
              isThinking: false
            });
          }
        }
      } finally {
          releasePersonalController(controller);
        if (streamId === chatStreamSeq) {
          this.chat.isSending = false;
          this.chat.isTyping = false;
          if (activeChatController === controller) activeChatController = null;
          this.$nextTick(() => this.scrollChatToBottom());
        }
      }
    },

    handleChatKeydown(event) {
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        this.sendMessage();
      }
    },

    autoResizeTextarea(event) {
      const el = event?.target || this.$refs.chatInput;
      if (!el) return;
      el.style.height = 'auto';
      el.style.height = Math.min(el.scrollHeight, 120) + 'px';
    },

    async clearChat() {
      if (!this.requireLogin('登录后才能清空个人聊天记录')) return;
      if (!confirm('确定要清空聊天记录吗？')) return;
      const accountContext = this.captureAccountContext();
      const oldSessionId = this.chat.sessionId;
      const controller = trackPersonalController(new AbortController());
      chatStreamSeq++;
      if (activeChatController) activeChatController.abort();
      activeChatController = null;
      this.chat.isSending = false;
      this.chat.isTyping = false;
      this.chat.messages = [];
      this.chat.sessionId = Utils.generateUUID();
      localStorage.removeItem('chat_session_id');
      localStorage.removeItem(CHAT_SESSION_OWNER_STORAGE_KEY);
      try {
        await API.chat.deleteHistory(oldSessionId, { signal: controller.signal });
      } catch (error) {
        if (error.name === 'AbortError' ||
            !this.isAccountContextCurrent(accountContext)) return;
        if (this.handleAuthError(error)) return;
        console.error('删除服务端聊天历史失败:', error);
      } finally {
        releasePersonalController(controller);
      }
    },

    scrollChatToBottom() {
      const el = this.$refs.chatMessages;
      if (!el) return;
      // 仅在用户已在底部时才自动滚动（30px 容差）
      const isAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
      if (isAtBottom) {
        el.scrollTop = el.scrollHeight;
      }
    },

    formatMessageContent(content) {
      return Utils.markdownToHTML(content);
    },

    formatArticleContent(content) {
      if (!content) return '';
      const value = String(content);
      const hasHtml = /<\/?[a-z][\s\S]*>/i.test(value);
      return hasHtml
        ? Utils.sanitizeHTML(value, { allowImages: true })
        : Utils.markdownToHTML(value);
    },

    formatTimestamp(timestamp) {
      return Utils.formatRelativeTime(timestamp);
    },

    // ===================== 文章 =====================

    async loadArticles() {
      const requestId = ++articleRequestSeq;
      if (articleRequestController) articleRequestController.abort();
      articleRequestController = new AbortController();
      this.articles.loading = true;
      this.articles.error = null;
      try {
        const articles = await API.articles.getList(
          { limit: ARTICLE_PAGE_SIZE },
          { signal: articleRequestController.signal }
        );
        if (requestId !== articleRequestSeq) return;
        this.articles.list = articles || [];
      } catch (error) {
        if (error.name === 'AbortError' || requestId !== articleRequestSeq) return;
        console.error('加载文章失败:', error);
        if (requestId === articleRequestSeq) {
          this.articles.error = error.message;
          this.articles.list = [];
        }
      } finally {
        if (requestId === articleRequestSeq) {
          this.articles.loading = false;
          articleRequestController = null;
        }
      }
    },

    queueArticleSearch() {
      if (articleSearchTimer) clearTimeout(articleSearchTimer);
      articleRequestSeq++;
      if (articleRequestController) articleRequestController.abort();
      articleRequestController = null;
      articleSearchTimer = setTimeout(() => {
        articleSearchTimer = null;
        this.searchArticles();
      }, 300);
    },

    async searchArticles() {
      const query = this.articles.searchQuery.trim();
      if (!query) {
        await this.loadArticles();
        return;
      }

      const requestId = ++articleRequestSeq;
      if (articleRequestController) articleRequestController.abort();
      articleRequestController = new AbortController();
      this.articles.loading = true;
      this.articles.error = null;
      try {
        const result = await API.articles.search(query, ARTICLE_PAGE_SIZE, {
          signal: articleRequestController.signal
        });
        if (requestId !== articleRequestSeq) return;
        this.articles.list = result.results || [];
      } catch (error) {
        if (error.name === 'AbortError' || requestId !== articleRequestSeq) return;
        console.error('搜索文章失败:', error);
        if (requestId === articleRequestSeq) {
          this.articles.error = error.message;
        }
      } finally {
        if (requestId === articleRequestSeq) {
          this.articles.loading = false;
          articleRequestController = null;
        }
      }
    },

    viewArticle(article) {
      this.selectedArticle = article;
    },

    formatDate(dateString) {
      return Utils.formatDate(dateString);
    },

    /**
     * 分析文章并添加事件到时间轴（文章卡片上的按钮）
     */
    async addArticleToTimeline(article) {
      if (!this.requireLogin('登录后才能把文章加入个人时间轴')) return;
      if (this.articlePicker.running) return;
      if (this.articleAnalyzing[article.id]) return;
      const accountContext = this.captureAccountContext();
      const controller = trackPersonalController(new AbortController());
      this.articleAnalyzing = { ...this.articleAnalyzing, [article.id]: true };
      try {
        const result = await API.articles.analyze(article.id, true, {
          signal: controller.signal
        });
        if (!this.isAccountContextCurrent(accountContext)) return;
        if (result.success) {
          this.showBanner(
            'success',
            '事件已添加',
            `从「${article.title}」中提取了 ${result.timeline_events_created} 个时间轴事件`
          );
          await this.loadTimeline();
        } else {
          this.showBanner('error', '分析失败', result.message);
        }
      } catch (error) {
        if (error.name === 'AbortError' ||
            !this.isAccountContextCurrent(accountContext)) return;
        if (this.handleAuthError(error)) return;
        console.error('添加事件失败:', error);
        this.showBanner('error', '请求失败', error.message);
      } finally {
        releasePersonalController(controller);
        if (this.isAccountContextCurrent(accountContext)) {
          this.articleAnalyzing = { ...this.articleAnalyzing, [article.id]: false };
        }
      }
    },

    // ===================== 校园新闻 =====================

    toggleNewsTab() {
      this.showNews = !this.showNews;
      if (this.showNews && !this.newsLoading && this.newsList.length === 0) {
        this.loadNews();
      }
    },

    async loadNews() {
      if (this.newsLoading) return;
      this.newsLoading = true;
      this.newsError = null;
      try {
        const result = await API.news.getList();
        this.newsList = result.news || [];
      } catch (error) {
        console.error('加载新闻失败:', error);
        this.newsError = error.message;
        this.newsList = [];
      } finally {
        this.newsLoading = false;
      }
    },

    async refreshNews() {
      if (this.newsLoading) return;
      this.newsLoading = true;
      this.newsError = null;
      try {
        const result = await API.news.refresh();
        this.newsList = result.news || [];
        this.showBanner('success', '新闻已更新', `获取到 ${this.newsList.length} 条校园新闻`);
      } catch (error) {
        console.error('刷新新闻失败:', error);
        this.newsError = error.message;
        this.showBanner('error', '刷新失败', error.message);
      } finally {
        this.newsLoading = false;
      }
    },

    async analyzeAndCreateTimeline() {
      if (!this.selectedAnalysisArticles.length) {
        this.showBanner('info', '请先勾选文章', '勾选文章卡片上的“选择分析”，再点击 AI 分析');
        return;
      }
      this.articlePicker.show = true;
      await this.analyzeSelectedArticles();
    },

    toggleArticleSelection(article, checked) {
      if (this.articlePicker.running) return;
      const id = String(article.id);
      if (checked) {
        if (!this.articlePicker.selectedIds.includes(id)) this.articlePicker.selectedIds.push(id);
        this.articlePicker.selectedArticles = [
          ...this.articlePicker.selectedArticles.filter(item => String(item.id) !== id), article
        ];
      } else {
        this.articlePicker.selectedIds = this.articlePicker.selectedIds.filter(value => value !== id);
        this.articlePicker.selectedArticles = this.articlePicker.selectedArticles.filter(item => String(item.id) !== id);
      }
    },

    selectFilteredArticles() {
      if (this.articlePicker.running) return;
      this.articlePicker.selectedIds = [...new Set([
        ...this.articlePicker.selectedIds,
        ...this.articles.list.map(article => String(article.id))
      ])];
      this.articlePicker.selectedArticles = [...new Map([
        ...this.articlePicker.selectedArticles, ...this.articles.list
      ].map(article => [String(article.id), article])).values()];
    },

    clearArticleSelection() {
      if (this.articlePicker.running) return;
      this.articlePicker.selectedIds = [];
      this.articlePicker.selectedArticles = [];
    },

    stopArticleAnalysis() {
      articleAnalysisRun++;
      if (articleAnalysisController) articleAnalysisController.abort();
      articleAnalysisController = null;
      this.articlePicker.running = false;
      this.isAnalyzingLatest = false;
      this.articlePicker.results = this.articlePicker.results.map(result => (
        result.status === 'running' ? { ...result, status: 'cancelled', message: '已停止' } : result
      ));
    },

    closeArticlePicker() {
      this.stopArticleAnalysis();
      this.articlePicker.show = false;
    },

    async analyzeSelectedArticles() {
      if (this.articlePicker.running) return;
      if (!this.user || !API.auth.getToken()) {
        this.closeArticlePicker();
        this.requireLogin('登录后才能分析所选文章并生成个人日程');
        return;
      }
      const selected = [...this.selectedAnalysisArticles];
      if (!selected.length) return;
      if (selected.some(article => this.articleAnalyzing[article.id])) {
        this.showBanner('info', '请稍候', '选中的文章正在分析中');
        return;
      }
      const accountContext = this.captureAccountContext();
      const run = ++articleAnalysisRun;
      const current = () => run === articleAnalysisRun && this.isAccountContextCurrent(accountContext);
      this.articlePicker.running = true;
      this.articlePicker.completed = 0;
      this.articlePicker.total = selected.length;
      this.articlePicker.results = [];
      this.isAnalyzingLatest = true;
      try {
        for (const article of selected) {
          if (!current()) return;
          const index = this.articlePicker.results.length;
          this.articlePicker.results.push({ id: String(article.id), title: article.title, status: 'running', message: '正在分析…' });
          const controller = trackPersonalController(new AbortController());
          articleAnalysisController = controller;
          try {
            const result = await API.articles.analyze(article.id, true, { signal: controller.signal });
            if (!current()) return;
            this.articlePicker.results[index] = {
              id: String(article.id), title: article.title,
              status: result.success ? 'success' : 'error',
              message: result.success ? `已创建 ${result.timeline_events_created || 0} 个事件` : (result.message || '分析失败')
            };
            this.articlePicker.completed++;
            if (result.success) await this.loadTimeline();
          } catch (error) {
            if (!current() || error.name === 'AbortError') return;
            if (this.handleAuthError(error)) return;
            this.articlePicker.results[index] = { id: String(article.id), title: article.title, status: 'error', message: error.message || '分析失败' };
            this.articlePicker.completed++;
            if (error.isNetworkError) break;
          } finally {
            releasePersonalController(controller);
            if (articleAnalysisController === controller) articleAnalysisController = null;
          }
        }
        if (current()) {
          if (this.articles.searchQuery.trim()) await this.searchArticles();
          else await this.loadArticles();
        }
      } finally {
        if (current()) {
          this.articlePicker.running = false;
          this.isAnalyzingLatest = false;
        }
      }
    },

    safeExternalUrl(url) {
      return Utils.safeUrl(url);
    },

    handleNewsClick(event, url) {
      if (!Utils.safeUrl(url)) {
        event.preventDefault();
        this.showBanner('error', '链接不可用', '新闻链接不是安全的 HTTP(S) 地址');
      }
    },

    // ===================== 课表 =====================

    async toggleSchedule() {
      this.schedule.show = !this.schedule.show;
      if (this.schedule.show) {
        this.updateWeekRange();
        await this.loadScheduleData();
      }
    },

    updateWeekRange() {
      const range = ScheduleData.getWeekRange(this.schedule.currentWeek, this.schedule.semesterStart);
      this.schedule.weekRange = range;
    },

    chooseScheduleFile() {
      if (!this.requireLogin('登录后才能导入个人课表')) return;
      if (this.schedule.importing) return;
      this.$refs.scheduleFileInput.click();
    },

    async importScheduleICS(event) {
      const input = event.target;
      const file = input.files[0];
      if (!file) return;
      if (!this.requireLogin('登录后才能导入个人课表')) {
        input.value = '';
        return;
      }
      if (this.schedule.importing) {
        input.value = '';
        return;
      }
      if (!/\.ics$/i.test(file.name) || file.size > 2 * 1024 * 1024) {
        this.showBanner('error', '无法导入', '请选择不超过 2 MB 的 .ics 课表文件');
        input.value = '';
        return;
      }
      const accountContext = this.captureAccountContext();
      const controller = trackPersonalController(new AbortController());
      this.schedule.importing = true;
      try {
        const result = await API.schedule.importICS(file, { signal: controller.signal });
        if (!this.isAccountContextCurrent(accountContext)) return;
        if (!result?.success) throw new Error(result?.message || '课表导入失败');

        // 同步时间轴以兼容原有左侧入口；失败时仍展示已保存的周课表。
        let timelineSyncError = '';
        try {
          const timelineResult = await API.timeline.importICS(file, { signal: controller.signal });
          if (!this.isAccountContextCurrent(accountContext)) return;
          if (!timelineResult?.success) throw new Error(timelineResult?.message || '时间轴同步失败');
        } catch (error) {
          if (error.name === 'AbortError' || !this.isAccountContextCurrent(accountContext)) return;
          if (this.handleAuthError(error)) return;
          timelineSyncError = error.message || '时间轴同步失败';
        }

        const firstWeek = Number(result.first_week);
        if (!Number.isInteger(firstWeek) || firstWeek < 1 || firstWeek > this.schedule.totalWeeks) {
          throw new Error('课表已保存，但服务器返回的教学周无效');
        }
        this.schedule.currentWeek = firstWeek;
        const skipped = result.skipped_events ? `，跳过 ${result.skipped_events} 个学期外事件` : '';
        this.updateWeekRange();
        this.schedule.show = true;
        this.mobilePanel = 'chat';
        this.schedule.expandedState = {};
        // 同一文件已写成周课程，避免时间轴标注再显示一份相同课程。
        this.schedule.showTimeline = false;
        this.schedule.timelineEvents = [];
        this.timeline.typeFilter = 'course';
        this.timeline.dateFilter.startDate = this.schedule.weekRange.start;
        this.timeline.dateFilter.endDate = ScheduleData.getWeekRange(
          this.schedule.totalWeeks, this.schedule.semesterStart
        ).end;

        // 导入过程中由这里显式刷新；不依赖异步周次 watcher 才能看到结果。
        await this.$nextTick();
        await this.loadScheduleData();
        if (!this.isAccountContextCurrent(accountContext)) return;
        await this.loadTimeline();
        if (!this.isAccountContextCurrent(accountContext)) return;
        if (this.schedule.error) {
          this.showBanner('error', '课表已保存，显示加载失败', this.schedule.error);
        } else if (timelineSyncError || this.timeline.error) {
          this.showBanner('error', '周课表已更新，时间轴同步失败', timelineSyncError || this.timeline.error);
        } else {
          this.showBanner('success', '课表已导入', `已切换到第 ${firstWeek} 周；新增 ${result.imported_courses} 条课程安排、${result.imported_occurrences} 次上课${skipped}`);
        }
      } catch (error) {
        if (error.name === 'AbortError' || !this.isAccountContextCurrent(accountContext)) return;
        if (this.handleAuthError(error)) return;
        this.showBanner('error', '课表导入失败', error.message);
      } finally {
        releasePersonalController(controller);
        input.value = '';
        if (this.isAccountContextCurrent(accountContext)) this.schedule.importing = false;
      }
    },

    async loadScheduleData() {
      if (!this.user) return;
      const requestId = ++scheduleRequestSeq;
      if (scheduleRequestController) scheduleRequestController.abort();
      scheduleTimelineRequestSeq++;
      if (scheduleTimelineRequestController) scheduleTimelineRequestController.abort();
      scheduleTimelineRequestController = null;
      scheduleRequestController = trackPersonalController(new AbortController());
      const requestController = scheduleRequestController;
      const accountContext = this.captureAccountContext();
      this.schedule.loading = true;
      this.schedule.error = null;
      try {
        // 加载课程
        const result = await API.schedule.getCourses(
          { week: this.schedule.currentWeek },
          { signal: requestController.signal }
        );
        if (requestId !== scheduleRequestSeq ||
            !this.isAccountContextCurrent(accountContext)) return;
        this.schedule.courses = result.courses || [];

        // 加载时间轴事件（如果勾选了）
        if (this.schedule.showTimeline) {
          await this.loadScheduleTimelineEvents();
        } else {
          this.schedule.timelineEvents = [];
        }
      } catch (error) {
        if (error.name === 'AbortError' ||
            requestId !== scheduleRequestSeq ||
            !this.isAccountContextCurrent(accountContext)) return;
        if (this.handleAuthError(error)) return;
        console.error('加载课表数据失败:', error);
        if (requestId === scheduleRequestSeq &&
            this.isAccountContextCurrent(accountContext)) {
          this.schedule.courses = [];
          this.schedule.error = error.message || '课表加载失败，请重试';
        }
      } finally {
        releasePersonalController(requestController);
        if (requestId === scheduleRequestSeq) {
          this.schedule.loading = false;
          if (scheduleRequestController === requestController) {
            scheduleRequestController = null;
          }
        }
      }
    },

    async loadScheduleTimelineEvents() {
      if (!this.user) {
        this.schedule.timelineEvents = [];
        return;
      }
      const requestId = ++scheduleTimelineRequestSeq;
      if (scheduleTimelineRequestController) scheduleTimelineRequestController.abort();
      const range = this.schedule.weekRange;
      if (!range.start || !range.end) {
        this.schedule.timelineEvents = [];
        return;
      }
      scheduleTimelineRequestController = trackPersonalController(new AbortController());
      const requestController = scheduleTimelineRequestController;
      const accountContext = this.captureAccountContext();
      try {
        const events = await API.timeline.getEvents({
          start_date: range.start,
          end_date: `${range.end}T23:59:59`
        }, {
          signal: requestController.signal
        });
        if (requestId !== scheduleTimelineRequestSeq ||
            !this.isAccountContextCurrent(accountContext)) return;
        this.schedule.timelineEvents = events || [];
      } catch (error) {
        if (error.name === 'AbortError' ||
            requestId !== scheduleTimelineRequestSeq ||
            !this.isAccountContextCurrent(accountContext)) return;
        if (this.handleAuthError(error)) return;
        console.error('加载时间轴事件失败:', error);
        if (requestId === scheduleTimelineRequestSeq &&
            this.isAccountContextCurrent(accountContext)) {
          this.schedule.timelineEvents = [];
        }
      } finally {
        releasePersonalController(requestController);
        if (requestId === scheduleTimelineRequestSeq) {
          if (scheduleTimelineRequestController === requestController) {
            scheduleTimelineRequestController = null;
          }
        }
      }
    },

    async onTimelineToggle() {
      if (this.schedule.showTimeline) {
        await this.loadScheduleTimelineEvents();
      } else {
        scheduleTimelineRequestSeq++;
        if (scheduleTimelineRequestController) scheduleTimelineRequestController.abort();
        scheduleTimelineRequestController = null;
        this.schedule.timelineEvents = [];
      }
    },

    prevWeek() {
      if (this.schedule.currentWeek > 1) {
        this.schedule.currentWeek--;
      }
    },

    nextWeek() {
      if (this.schedule.currentWeek < this.schedule.totalWeeks) {
        this.schedule.currentWeek++;
      }
    },

    getCellEvents(day, slotId) {
      return (this.scheduleGrid[day] && this.scheduleGrid[day][slotId]) || [];
    },

    isEventExpanded(day, slotId, evtIdx) {
      const key = `${day}-${slotId}-${evtIdx}`;
      return !!this.schedule.expandedState[key];
    },

    toggleEventExpand(day, slotId, evtIdx) {
      const key = `${day}-${slotId}-${evtIdx}`;
      const current = this.schedule.expandedState[key];
      this.schedule.expandedState = { ...this.schedule.expandedState, [key]: !current };
    },

    // ── 自定义课程 ──

    async saveCustomCourse() {
      if (!this.requireLogin('登录后才能保存个人课表')) return;
      if (this.isSavingCourse) return;
      const form = this.addCourseForm;
      if (!form.name.trim()) {
        this.showBanner('error', '请输入课程名称');
        return;
      }
      if (!form.start_time || !form.end_time || form.start_time >= form.end_time) {
        this.showBanner('error', '课程时间无效', '结束时间必须晚于开始时间');
        return;
      }
      const accountContext = this.captureAccountContext();
      const controller = trackPersonalController(new AbortController());
      this.isSavingCourse = true;
      try {
        await API.schedule.addCourse({
          name: form.name.trim(),
          room: form.room.trim(),
          teacher: form.teacher.trim(),
          day_of_week: form.day_of_week,
          start_time: form.start_time,
          end_time: form.end_time,
          week_numbers: form.week_numbers.length > 0 ? form.week_numbers : [this.schedule.currentWeek]
        }, { signal: controller.signal });
        if (!this.isAccountContextCurrent(accountContext)) return;
        this.showBanner('success', '课程已添加');
        this.showAddCourse = false;
        this.resetAddCourseForm();
        await this.loadScheduleData();
      } catch (error) {
        if (error.name === 'AbortError' ||
            !this.isAccountContextCurrent(accountContext)) return;
        if (this.handleAuthError(error)) return;
        this.showBanner('error', '添加失败', error.message);
      } finally {
        releasePersonalController(controller);
        if (this.isAccountContextCurrent(accountContext)) {
          this.isSavingCourse = false;
        }
      }
    },

    resetAddCourseForm() {
      this.addCourseForm = {
        name: '',
        room: '',
        teacher: '',
        day_of_week: 1,
        start_time: '08:00',
        end_time: '09:40',
        week_numbers: []
      };
    },

    // ===================== 设置 =====================

    async loadSettings() {
      try {
        const settings = await API.settings.get();
        Object.keys(this.settings).forEach(key => {
          if (settings[key] !== undefined) this.settings[key] = settings[key];
        });
      } catch (error) {
        console.error('加载设置失败:', error);
      }
    },

    async saveSettings() {
      if (!this.requireLogin('登录后才能保存系统设置')) return;
      const accountContext = this.captureAccountContext();
      const controller = trackPersonalController(new AbortController());
      try {
        await API.settings.update(this.settings, { signal: controller.signal });
        if (!this.isAccountContextCurrent(accountContext)) return;
        this.showBanner('success', '设置已保存');
        this.showSettings = false;
      } catch (error) {
        if (error.name === 'AbortError' ||
            !this.isAccountContextCurrent(accountContext)) return;
        if (this.handleAuthError(error)) return;
        console.error('保存设置失败:', error);
        this.showBanner('error', '保存失败', error.message);
      } finally {
        releasePersonalController(controller);
      }
    },

    // ===================== 唤醒任务 =====================

    async loadWakeTasks() {
      if (!this.user) {
        this.wakeTasks = [];
        return;
      }
      const accountContext = this.captureAccountContext();
      const controller = trackPersonalController(new AbortController());
      try {
        const result = await API.wake.getTasks({ signal: controller.signal });
        if (!this.isAccountContextCurrent(accountContext)) return;
        this.wakeTasks = result.tasks || [];
      } catch (error) {
        if (error.name === 'AbortError' ||
            !this.isAccountContextCurrent(accountContext)) return;
        if (this.handleAuthError(error)) return;
        console.error('加载唤醒任务失败:', error);
      } finally {
        releasePersonalController(controller);
      }
    },

    async addWakeTask() {
      if (!this.requireLogin('登录后才能添加个人唤醒任务')) return;
      if (this.isAddingWakeTask) return;
      const prompt = this.newWakeTaskPrompt.trim();
      if (!prompt) return;
      const accountContext = this.captureAccountContext();
      const controller = trackPersonalController(new AbortController());
      this.isAddingWakeTask = true;
      try {
        await API.wake.addTask(prompt, '', { signal: controller.signal });
        if (!this.isAccountContextCurrent(accountContext)) return;
        this.newWakeTaskPrompt = '';
        await this.loadWakeTasks();
        if (!this.isAccountContextCurrent(accountContext)) return;
        this.showBanner('success', '唤醒任务已添加');
      } catch (error) {
        if (error.name === 'AbortError' ||
            !this.isAccountContextCurrent(accountContext)) return;
        if (this.handleAuthError(error)) return;
        this.showBanner('error', '添加失败', error.message);
      } finally {
        releasePersonalController(controller);
        if (this.isAccountContextCurrent(accountContext)) {
          this.isAddingWakeTask = false;
        }
      }
    },

    async deleteWakeTask(taskId) {
      if (!this.requireLogin('登录后才能管理个人唤醒任务')) return;
      const accountContext = this.captureAccountContext();
      const controller = trackPersonalController(new AbortController());
      try {
        await API.wake.deleteTask(taskId, { signal: controller.signal });
        if (!this.isAccountContextCurrent(accountContext)) return;
        await this.loadWakeTasks();
        this.showBanner('success', '任务已删除');
      } catch (error) {
        if (error.name === 'AbortError' ||
            !this.isAccountContextCurrent(accountContext)) return;
        if (this.handleAuthError(error)) return;
        this.showBanner('error', '删除失败', error.message);
      } finally {
        releasePersonalController(controller);
      }
    },

    // ===================== 聊天历史持久化 =====================

    async restoreChatSession() {
      if (!this.user) {
        this.chat.isRestoring = false;
        return;
      }
      let savedSessionId = localStorage.getItem('chat_session_id');
      const savedSessionOwner = localStorage.getItem(CHAT_SESSION_OWNER_STORAGE_KEY);
      if (savedSessionId && savedSessionOwner !== this.user.username) {
        localStorage.removeItem('chat_session_id');
        localStorage.removeItem(CHAT_SESSION_OWNER_STORAGE_KEY);
        savedSessionId = null;
      }
      const accountContext = this.captureAccountContext();
      const controller = trackPersonalController(new AbortController());
      try {
        if (!savedSessionId) {
          const result = await API.chat.getSessions({ signal: controller.signal });
          if (!this.isAccountContextCurrent(accountContext)) return;
          const sessions = Array.isArray(result?.sessions) ? result.sessions : [];
          const latest = [...sessions].sort((a, b) => (
            (Date.parse(b.last_time || b.last_timestamp || '') || 0) -
            (Date.parse(a.last_time || a.last_timestamp || '') || 0)
          ))[0];
          savedSessionId = latest?.id || latest?.session_id || null;
        }
        if (!savedSessionId) return;
        const result = await API.chat.getHistory(savedSessionId, {
          signal: controller.signal
        });
        if (!this.isAccountContextCurrent(accountContext)) return;
        if (result && result.messages && result.messages.length > 0) {
          this.chat.sessionId = savedSessionId;
          this.chat.messages = result.messages.map((message, index) => ({
            ...message,
            id: message.id || `history_${index}_${message.timestamp || ''}`,
            isThinking: false
          }));
          this.saveChatSession();
        } else {
          localStorage.removeItem('chat_session_id');
          localStorage.removeItem(CHAT_SESSION_OWNER_STORAGE_KEY);
          this.chat.sessionId = Utils.generateUUID();
          this.chat.messages = [];
        }
      } catch (error) {
        if (error.name === 'AbortError' ||
            !this.isAccountContextCurrent(accountContext)) return;
        if (this.handleAuthError(error)) return;
        console.error('恢复聊天会话失败:', error);
        localStorage.removeItem('chat_session_id');
        localStorage.removeItem(CHAT_SESSION_OWNER_STORAGE_KEY);
        this.chat.sessionId = Utils.generateUUID();
        this.chat.messages = [];
      } finally {
        releasePersonalController(controller);
        if (this.isAccountContextCurrent(accountContext)) {
          this.chat.isRestoring = false;
        }
      }
    },

    saveChatSession() {
      if (!this.user) return;
      localStorage.setItem('chat_session_id', this.chat.sessionId);
      localStorage.setItem(CHAT_SESSION_OWNER_STORAGE_KEY, this.user.username);
    }
  }
}).mount('#app');

window.AppStartup?.ready();
