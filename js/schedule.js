/**
 * XDAgent 课表数据处理模块
 * 处理周次计算、课程分组、时间轴事件合并、重叠布局
 */

const ScheduleData = {

    // ── 常量 ──

    DAY_NAMES: ['周一', '周二', '周三', '周四', '周五', '周六', '周日'],

    // 标准课时段（12节次）
    TIME_SLOTS: [
        { id: 1, label: '第1-2节', start: '08:30', end: '10:05' },
        { id: 2, label: '第3-4节', start: '10:25', end: '12:00' },
        { id: 3, label: '第5-6节', start: '14:00', end: '15:35' },
        { id: 4, label: '第7-8节', start: '15:55', end: '17:30' },
        { id: 5, label: '第9-10节', start: '19:00', end: '20:35' },
        { id: 6, label: '第11-12节', start: '20:40', end: '21:25' }
    ],

    // ── 周次计算 ──

    /**
     * 根据周次计算周一~周日日期范围
     * @param {number} week - 周次 (1-based)
     * @param {string} semesterStart - 第1周周一的日期 YYYY-MM-DD
     * @returns {{ start: string, end: string, dates: string[] }}
     */
    getWeekRange(week, semesterStart = '2026-02-23') {
        const start = this._parseLocalDate(semesterStart);
        if (!start) return { start: '', end: '', dates: [] };
        const normalizedWeek = Number.isFinite(Number(week)) ? Math.max(1, Number(week)) : 1;
        const weekStart = new Date(start);
        weekStart.setDate(start.getDate() + (normalizedWeek - 1) * 7);

        const dates = [];
        for (let i = 0; i < 7; i++) {
            const d = new Date(weekStart);
            d.setDate(weekStart.getDate() + i);
            dates.push(this._formatDate(d));
        }
        return {
            start: dates[0],
            end: dates[6],
            dates
        };
    },

    /**
     * 获取当前周次
     */
    getCurrentWeek(semesterStart = '2026-02-23') {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const start = this._parseLocalDate(semesterStart);
        if (!start) return 1;
        const diffDays = Math.floor((today - start) / 86400000);
        if (diffDays < 0) return 1;
        const week = Math.floor(diffDays / 7) + 1;
        return Math.max(1, Math.min(20, week));
    },

    _parseLocalDate(value) {
        if (value instanceof Date) {
            return Number.isNaN(value.getTime()) ? null : new Date(value);
        }
        const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
        if (!match) return null;
        return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    },

    _formatDate(date) {
        const y = date.getFullYear();
        const m = String(date.getMonth() + 1).padStart(2, '0');
        const d = String(date.getDate()).padStart(2, '0');
        return `${y}-${m}-${d}`;
    },

    // ── 时间工具 ──

    _timeToMinutes(timeStr) {
        const match = String(timeStr || '').match(/^(\d{2}):(\d{2})$/);
        if (!match) return NaN;
        const h = Number(match[1]);
        const m = Number(match[2]);
        if (h > 23 || m > 59) return NaN;
        return h * 60 + m;
    },

    /**
     * 判断事件时间属于哪个课时段
     */
    _assignTimeSlot(eventTime, duration, endTime) {
        const eventStart = this._timeToMinutes(eventTime);
        const eventEnd = endTime ? this._timeToMinutes(endTime) : eventStart + (duration || 90);
        if (!Number.isFinite(eventStart) || !Number.isFinite(eventEnd) || eventEnd <= eventStart) {
            return 0;
        }

        let bestSlot = 0;
        let bestOverlap = 0;
        for (const slot of this.TIME_SLOTS) {
            const slotStart = this._timeToMinutes(slot.start);
            const slotEnd = this._timeToMinutes(slot.end);
            // 按重叠时长分组，避免 10:00 的课因重叠 5 分钟被放进 08:30。
            const overlap = Math.min(eventEnd, slotEnd) - Math.max(eventStart, slotStart);
            if (overlap > bestOverlap) {
                bestOverlap = overlap;
                bestSlot = slot.id;
            }
        }
        // 不属于任何标准时段 → 放到"其他"时段（id=0）
        return bestSlot;
    },

    // ── 数据分组 ──

    /**
     * 将课程列表按天和周次过滤，再按课时段分组
     * @param {object[]} courses - 课程列表
     * @param {number} week - 当前周次
     * @returns {object} { dayOfWeek: { timeSlotId: [courses] } }
     */
    groupCourses(courses, week) {
        const result = {};
        if (!Array.isArray(courses)) return result;
        // 初始化 7 天
        for (let d = 1; d <= 7; d++) {
            result[d] = {};
            for (const slot of this.TIME_SLOTS) {
                result[d][slot.id] = [];
            }
            result[d][0] = []; // "其他"时段
        }

        for (const course of courses) {
            // 过滤周次
            if (!course || typeof course !== 'object') continue;
            const weekNumbers = Array.isArray(course.week_numbers)
                ? course.week_numbers.map(Number)
                : [];
            if (week && weekNumbers.length && !weekNumbers.includes(Number(week))) {
                continue;
            }
            const day = Number(course.day_of_week);
            const slotId = this._assignTimeSlot(course.start_time, null, course.end_time);
            if (!result[day]) continue;
            if (result[day][slotId] === undefined) {
                result[day][slotId] = [];
            }
            result[day][slotId].push({
                ...course,
                _type: 'course',
                _displayTime: `${course.start_time}-${course.end_time}`
            });
        }
        return result;
    },

    /**
     * 将时间轴事件按日期和周次过滤，再按天+时段分组
     * @param {object[]} events - 时间轴事件列表
     * @param {string[]} weekDates - 当前周的7天日期数组
     * @returns {object} { dayOfWeek: { timeSlotId: [events] } }
     */
    groupTimelineEvents(events, weekDates) {
        const result = {};
        if (!Array.isArray(events)) return result;
        for (let d = 1; d <= 7; d++) {
            result[d] = {};
            for (const slot of this.TIME_SLOTS) {
                result[d][slot.id] = [];
            }
            result[d][0] = [];
        }

        const dates = Array.isArray(weekDates) ? weekDates : [];
        for (const event of events) {
            if (!event || !event.time) continue;
            const eventTime = new Date(event.time);
            if (Number.isNaN(eventTime.getTime())) continue;
            const eventDate = this._formatDate(eventTime);
            // 检查是否在当前周
            const dayIndex = dates.indexOf(eventDate);
            if (dayIndex === -1) continue;
            const day = dayIndex + 1; // 1=Monday

            // 提取事件时间
            const timePart = `${String(eventTime.getHours()).padStart(2, '0')}:${String(eventTime.getMinutes()).padStart(2, '0')}`;
            const slotId = this._assignTimeSlot(timePart, event.duration || 60);

            if (!result[day]) continue;
            if (result[day][slotId] === undefined) {
                result[day][slotId] = [];
            }
            result[day][slotId].push({
                id: event.id,
                name: event.title,
                room: event.location || '',
                _type: 'timeline',
                _source: event.source,
                _color: event.color || '#D97757',
                _displayTime: event.duration
                    ? `${timePart} (${event.duration}min)`
                    : timePart,
                _fullDescription: event.description || '',
                _eventTime: event.time
            });
        }
        return result;
    },

    /**
     * 合并课程和时间轴事件分组
     * @param {object} courseGroup - groupCourses 的结果
     * @param {object} timelineGroup - groupTimelineEvents 的结果
     * @returns {object} { dayOfWeek: { timeSlotId: [items] } }
     */
    mergeGroups(courseGroup, timelineGroup) {
        const merged = {};
        for (let d = 1; d <= 7; d++) {
            merged[d] = {};
            const allSlotIds = [...this.TIME_SLOTS.map(s => s.id), 0];
            for (const slotId of allSlotIds) {
                const courses = (courseGroup[d] && courseGroup[d][slotId]) || [];
                const events = (timelineGroup[d] && timelineGroup[d][slotId]) || [];
                merged[d][slotId] = [...courses, ...events];
            }
        }
        return merged;
    },

    // ── 重叠布局计算 ──

    /**
     * 计算同一单元格内多个事件的布局
     * @param {object[]} items - 同一时段的所有事件
     * @returns {object[]} items with layout info: { top, height, overflow, bg }
     */
    computeLayout(items) {
        if (!items || items.length === 0) return [];
        const N = items.length;
        return items.map((item, index) => ({
            ...item,
            _layout: {
                top: `${(index / N) * 100}%`,
                height: `${(1 / N) * 100}%`,
                bg: index % 2 === 0 ? 'var(--color-bg-raised)' : 'var(--color-bg-overlay)',
                overflow: false, // runtime check
                expanded: false
            }
        }));
    }
};
