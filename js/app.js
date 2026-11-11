/**
 * XDAgent Vue 3 应用
 *
 * 主应用逻辑，包含登录、课表查询、水电费查询等功能
 */

const { createApp } = Vue;

createApp({
    data() {
        return {
            // 登录状态
            isLoggedIn: false,
            isLogging: false,
            loginError: '',

            // 登录表单
            loginForm: {
                studentId: '',
                password: ''
            },

            // 用户信息
            userInfo: {
                name: '',
                studentId: '',
                major: '',
                className: ''
            },

            // 校园数据
            campusData: {
                // 课表
                schedule: [],
                // 水费
                water: null,
                // 电费
                electricity: null,
                // 设施
                facilities: [],
                // 近期事件
                upcomingEvents: [],
                // 校历
                calendarItems: []
            },

            // 加载状态
            isLoadingSchedule: false,
            isLoadingUtilities: false,
            isRefreshingData: false,

            // 最后更新时间
            lastUpdateTime: '--'
        };
    },

    mounted() {
        // 检查是否已登录
        this.checkLoginStatus();
    },

    methods: {
        /**
         * 检查登录状态
         */
        async checkLoginStatus() {
            if (!API.auth.isLoggedIn()) return;

            try {
                const userInfo = await API.auth.getCurrentUser();
                this.isLoggedIn = true;
                this.userInfo = this.normalizeUserInfo(userInfo);
                await this.loadAllData();
            } catch (error) {
                console.error('检查登录状态失败:', error);
                API.auth.clearToken();
                this.isLoggedIn = false;
            }
        },

        normalizeUserInfo(user) {
            return {
                name: user?.name || '',
                studentId: user?.student_id || '',
                major: user?.major || '',
                className: user?.class_name || user?.className || ''
            };
        },

        /**
         * 执行登录
         */
        async doLogin() {
            if (this.isLogging) return;
            // 验证输入
            if (!this.loginForm.studentId || !this.loginForm.password) {
                this.loginError = '请输入学号和密码';
                return;
            }

            this.isLogging = true;
            this.loginError = '';

            try {
                const response = await API.auth.login(
                    this.loginForm.studentId,
                    this.loginForm.password
                );

                // 登录成功
                this.isLoggedIn = true;
                this.userInfo = this.normalizeUserInfo(response.user);

                // 清空表单
                this.loginForm.studentId = '';
                this.loginForm.password = '';

                // 加载数据
                this.loadAllData();
            } catch (error) {
                console.error('Login error:', error);
                this.loginError = error.message || '登录失败，请检查学号和密码';
            } finally {
                this.isLogging = false;
            }
        },

        /**
         * 登出
         */
        async logout() {
            if (confirm('确定要退出登录吗？')) {
                try {
                    await API.auth.logout();
                } catch (error) {
                    console.error('登出请求失败，已清理本地登录状态:', error);
                } finally {
                    this.isLoggedIn = false;
                    this.userInfo = {
                        name: '',
                        studentId: '',
                        major: '',
                        className: ''
                    };
                    this.campusData = {
                        schedule: [],
                        water: null,
                        electricity: null,
                        facilities: [],
                        upcomingEvents: [],
                        calendarItems: []
                    };
                }
            }
        },

        /**
         * 加载所有数据
         */
        async loadAllData() {
            if (this.isRefreshingData) return;
            this.isRefreshingData = true;
            try {
                await Promise.all([
                    this.loadSchedule(),
                    this.loadUtilities(),
                    this.loadFacilities(),
                    this.loadCalendar()
                ]);
            } finally {
                this.isRefreshingData = false;
            }
        },

        /**
         * 加载课表
         */
        async loadSchedule() {
            this.isLoadingSchedule = true;
            try {
                const response = await API.campus.getMySchedule();
                if (response && response.schedule) {
                    this.campusData.schedule = response.schedule;
                }
            } catch (error) {
                console.error('Load schedule error:', error);
                // 使用模拟数据
                this.campusData.schedule = this.getMockSchedule();
            } finally {
                this.isLoadingSchedule = false;
            }
        },

        /**
         * 加载水电费
         */
        async loadUtilities() {
            this.isLoadingUtilities = true;
            try {
                const response = await API.campus.getMyUtilities();
                if (response) {
                    this.campusData.water = response.water_balance || response.water || 0;
                    this.campusData.electricity = response.electricity_balance || response.electricity || 0;
                    this.lastUpdateTime = Utils.formatDateTime(response.last_update || new Date().toISOString());
                }
            } catch (error) {
                console.error('Load utilities error:', error);
                // 使用模拟数据
                this.campusData.water = 45.5;
                this.campusData.electricity = 156.8;
                this.lastUpdateTime = Utils.getCurrentTime();
            } finally {
                this.isLoadingUtilities = false;
            }
        },

        /**
         * 加载运动设施状态
         */
        async loadFacilities() {
            try {
                const facilities = await API.campus.getFacilities();
                this.campusData.facilities = facilities;
            } catch (error) {
                console.error('Load facilities error:', error);
                // 使用模拟数据
                this.campusData.facilities = [
                    { name: '健身房', icon: '🏃', available: true, time: '06:00-22:00' },
                    { name: '游泳池', icon: '🏊', available: false, time: '已关闭' },
                    { name: '篮球场', icon: '🏀', available: true, time: '全天开放' }
                ];
            }
        },

        /**
         * 加载校历
         */
        async loadCalendar() {
            try {
                const response = await API.campus.getCalendar();
                if (response && response.academic_year) {
                    this.campusData.calendarItems = [
                        { label: '学年', value: response.academic_year },
                        { label: '当前学期', value: response.semesters[0]?.name || '春季学期' },
                        { label: '学期开始', value: Utils.formatDate(response.semesters[0]?.start_date) },
                        { label: '学期结束', value: Utils.formatDate(response.semesters[0]?.end_date) }
                    ];

                    // 提取近期事件
                    if (response.semesters[0]?.holidays) {
                        this.campusData.upcomingEvents = response.semesters[0].holidays.map(h => ({
                            date: h.date,
                            title: h.name
                        }));
                    }
                }
            } catch (error) {
                console.error('Load calendar error:', error);
                // 使用模拟数据
                this.campusData.calendarItems = [
                    { label: '学年', value: '2025-2026' },
                    { label: '当前学期', value: '春季学期' },
                    { label: '学期开始', value: '2026-02-25' },
                    { label: '学期结束', value: '2026-07-15' }
                ];
                this.campusData.upcomingEvents = [
                    { date: '2026-04-04', title: '清明节' },
                    { date: '2026-05-01', title: '劳动节' },
                    { date: '2026-06-15', title: '期末考试' }
                ];
            }
        },

        /**
         * 刷新数据
         */
        async refreshData() {
            if (this.isRefreshingData) return;
            await this.loadAllData();
            alert('数据已刷新');
        },

        /**
         * 获取模拟课表（用于演示）
         */
        getMockSchedule() {
            return [
                {
                    time: '08:00-09:40',
                    courses: [
                        { name: '离散数学', room: '理科楼A101' },
                        { name: '数据结构', room: '理科楼A102' },
                        { name: '算法设计', room: '理科楼A103' },
                        { name: '编译原理', room: '理科楼A104' },
                        { name: '计算机网络', room: '理科楼A105' }
                    ]
                },
                {
                    time: '10:00-11:40',
                    courses: [
                        null,
                        { name: '线性代数', room: '理科楼B201' },
                        null,
                        { name: '操作系统', room: '理科楼A206' },
                        null
                    ]
                },
                {
                    time: '14:00-15:40',
                    courses: [
                        { name: '软件工程', room: '理科楼C301' },
                        null,
                        { name: '数据库原理', room: '理科楼C302' },
                        null,
                        { name: '人工智能', room: '理科楼C303' }
                    ]
                },
                {
                    time: '16:00-17:40',
                    courses: [
                        null,
                        { name: '计算机组成', room: '理科楼D401' },
                        null,
                        { name: '计算机图形学', room: '理科楼D402' },
                        null
                    ]
                },
                {
                    time: '19:00-20:40',
                    courses: [
                        null,
                        null,
                        { name: '机器学习', room: '理科楼E501' },
                        null,
                        null
                    ]
                }
            ];
        }
    }
}).mount('#campus-app');
