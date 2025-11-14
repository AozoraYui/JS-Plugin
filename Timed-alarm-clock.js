import common from '../../lib/common/common.js';
import schedule from 'node-schedule';
import moment from 'moment-timezone';

// Redis 键的前缀，方便管理
const ALARM_REDIS_PREFIX = 'alarm:clock:';

export class AlarmClock extends plugin {
  constructor() {
    super({
      name: '定时闹钟',
      dsc: '在指定时间@用户，提醒设定的事项（支持循环）',
      event: 'message',
      priority: 100, // 优先级可以适当调整
      rule: [
        {
          reg: '^#定时(闹钟)?(.*)$',
          fnc: 'setAlarmStep1'
        },
        {
          reg: '^#闹钟(详细)?帮助$',
          fnc: 'alarmHelp'
        },
        {
          reg: '^#闹钟(列表|队列)$',
          fnc: 'listAlarms'
        },
        {
          reg: '^#闹钟取消\\s*([\\d\\s]+)$',
          fnc: 'cancelAlarm'
        },
        {
          reg: '^#全部闹钟(列表|队列)$',
          fnc: 'listAllAlarms',
          permission: 'master'
        }
      ]
    });

    // 使用全局变量作为开关，确保恢复任务只执行一次
    if (!global.ALARM_CLOCK_INITIALIZED) {
      this.restoreAlarmsFromRedis();
      global.ALARM_CLOCK_INITIALIZED = true;
    }
  }

  /**
   * 发送帮助信息
   */
  async alarmHelp(e) {
    const isDetailed = e.msg.includes('详细');

    if (isDetailed) {
      // --- 详细版帮助 ---
      const helpMsg = `喵~ 这是超级详细的闹钟使用手册哦！
        
--- 1. 创建单次闹钟 ---
#定时闹钟 [时间] [@某人]
我能听懂很多种时间说法，用起来非常方便！

【常用说法】
#定时闹钟 今天下午3点
#定时闹钟 明晚9点30分
#定时闹钟 明天早上8点半
#定时闹钟 后天中午12点

【指定日期】
#定时闹钟 9月12日 早上7:30:15 (精确到秒！)
#定时闹钟 2025年10月1号 16:00

【快速设置】
#定时闹钟 10分钟后
#定时闹钟 1小时30分钟后

--- 2. 创建循环闹钟 ---
#定时闹钟 [频率] [时间] [@某人]
让我在固定的时间循环提醒你！

【每天】
#定时闹钟 每天早上8点
#定时闹钟 每天20:30:15 (也支持秒哦)

【每周】
#定时闹钟 每周一下午3点
#定时闹钟 每周日晚上9点半
#定时闹钟 每周6 18:00 (星期也支持数字1-7/0)

【每月】
#定时闹钟 每月15号中午12点
#定时闹钟 每月1日 08:30

【每年】
#定时闹钟 每年10月1号 早上8点
#定时闹钟 每年1月1日 00:00

--- 3. 管理你的闹钟 ---
【查看闹钟队列】
#闹钟列表
(在群里使用会看到本群的，私聊使用只会看到你自己的)

【取消闹钟 (支持批量！)】
#闹钟取消 [序号]
#闹钟取消 [序号1] [序号2]...
> 示例1: #闹钟取消 1
> 示例2: #闹钟取消 1 3 5 (一次取消多个！)

(序号通过「#闹钟列表」查看)

--- 4. 主人专用指令 ---
#全部闹钟队列
(查看机器人上所有群聊和私聊的闹钟)

喵~ 快来试试这些强大的新功能吧！`;
      await e.reply(helpMsg, true);
    } else {
      // --- 简化版帮助 ---
      const helpMsg = `喵~ 定时闹钟快速上手指南！

--- 创建闹钟 ---
#定时闹钟 [时间] [@某人]
> 单次: #定时闹钟 明天下午3点半
> 循环: #定时闹钟 每天早上8点
> 批量取消: #闹钟取消 1 3

--- 管理闹钟 ---
#闹钟列表  (查看当前场景的闹钟)
#闹钟取消 [序号1] [序号2]...

私聊我也能设置私人闹钟哦！
发送 “#闹钟详细帮助” 查看全部功能！`;
      await e.reply(helpMsg, true);
    }
    return true;
  }

  /**
   * 获取用户昵称的辅助函数
   */
  async getUserProfile(userId, groupId = null) {
    if (groupId) {
      try {
        const member = await Bot.getGroupMemberInfo(groupId, userId).catch(() => null);
        if (member) {
          return member.card || member.nickname;
        }
      } catch (error) { }
    }
    try {
      const friend = Bot.fl.get(Number(userId));
      if (friend) {
        return friend.nickname;
      }
    } catch (e) { }
    return userId.toString();
  }

  /**
   * @param {object} filter - 过滤器 { group_id: '123' } 或 { user_id: '456' }
   */
  async getAlarms(filter = {}) {
    let alarms = [];
    let cursor = 0;
    do {
      const result = await redis.scan(cursor, { MATCH: `${ALARM_REDIS_PREFIX}*`, COUNT: 100 });
      cursor = result.cursor;
      const keys = result.keys;

      if (keys && keys.length > 0) {
        for (const key of keys) {
          const alarmDataStr = await redis.get(key);
          if (alarmDataStr) {
            try {
              const alarmData = JSON.parse(alarmDataStr);
              
              let shouldKeep = true;

              if (filter.group_id) {
                // 按群组过滤：group_id 必须完全匹配
                if (alarmData.group_id != filter.group_id) {
                  shouldKeep = false;
                }
              } else if (filter.user_id) {
                // 按用户过滤，条件是：
                // 1. alarmData.group_id 必须是 "falsy" (即 null 或 undefined)
                // 2. target_id 必须匹配
                // 如果任一条件不满足，则丢弃。
                if (alarmData.group_id || alarmData.target_id != filter.user_id) {
                   shouldKeep = false;
                }
              }
              // 如果 filter 为空 (来自 listAllAlarms), 则保留所有

              if (shouldKeep) {
                alarms.push(alarmData);
              }

            } catch (parseError) {
              logger.error(`[定时闹钟] 解析Redis中的闹钟数据失败, key: ${key}`, parseError);
            }
          }
        }
      }
    } while (cursor !== 0);

    alarms.sort((a, b) => moment(a.time).valueOf() - moment(b.time).valueOf());
    return alarms;
  }

  /**
   * 查看单个群的闹钟列表
   */
  async listAlarms(e) {
    // --- MODIFIED: 根据场景（群/私聊）传递不同的过滤器 ---
    const alarms = e.isGroup 
        ? await this.getAlarms({ group_id: e.group_id }) 
        : await this.getAlarms({ user_id: e.user_id });

    if (!alarms || alarms.length === 0) {
      const replyMsg = e.isGroup ? '本群当前还没有待执行的闹钟哦~' : '您当前还没有待执行的闹钟哦~';
      await e.reply(replyMsg, true);
      return true;
    }

    const listTitle = e.isGroup ? '本群的闹钟队列' : '您的闹钟队列';
    let forwardMsg = [`${listTitle}如下 (序号按时间顺序排列)：`];

    for (let i = 0; i < alarms.length; i++) {
      const alarm = alarms[i];
      const setterName = await this.getUserProfile(alarm.setter_id, alarm.group_id);
      const targetName = await this.getUserProfile(alarm.target_id, alarm.group_id);

      let timeDisplay;
      if (alarm.recurrenceRule) {
        const cronParts = alarm.recurrenceRule.split(' ');
        let timeStr;
        if (cronParts.length === 6) {
            const second = cronParts[0].padStart(2, '0');
            const minute = cronParts[1].padStart(2, '0');
            const hour = cronParts[2].padStart(2, '0');
            timeStr = `${hour}:${minute}`;
            if (second !== '00') timeStr += `:${second}`;
        } else {
            const minute = cronParts[0].padStart(2, '0');
            const hour = cronParts[1].padStart(2, '0');
            timeStr = `${hour}:${minute}`;
        }
        timeDisplay = `${alarm.recurrenceText} ${timeStr}`;
      } else {
        timeDisplay = moment(alarm.time).format("MM-DD HH:mm:ss");
      }

      let msg = `${i + 1}. [${timeDisplay}]
提醒对象：${targetName}
创建人：${setterName}
内容：“${alarm.content}”`;
      forwardMsg.push(msg);
    }

    if (forwardMsg.length > 1) {
      await e.reply(await common.makeForwardMsg(e, listTitle, forwardMsg));
    }
    return true;
  }

  /**
   * 查看所有群的闹钟列表 (主人专用)
   */
  async listAllAlarms(e) {
    const allAlarms = await this.getAlarms(); // 获取所有闹钟

    if (!allAlarms || allAlarms.length === 0) {
      await e.reply('所有地方都没有待执行的闹钟哦~', true);
      return true;
    }

    // --- MODIFIED: 将闹钟分为群聊和私聊两大类 ---
    const groupedAlarms = {};
    const privateAlarms = [];
    for (const alarm of allAlarms) {
      if (alarm.group_id) { // 如果有 group_id, 归为群聊
        if (!groupedAlarms[alarm.group_id]) {
          groupedAlarms[alarm.group_id] = [];
        }
        groupedAlarms[alarm.group_id].push(alarm);
      } else { // 否则归为私聊
        privateAlarms.push(alarm);
      }
    }

    let forwardMsg = [`为您展示所有闹钟队列，共 ${allAlarms.length} 个任务：`];
    
    // 1. 先展示所有群聊的闹钟
    for (const groupId in groupedAlarms) {
      const groupAlarms = groupedAlarms[groupId];
      const group = Bot.gl.get(Number(groupId));
      const groupName = group ? `${group.group_name}(${groupId})` : `未知或已退群(${groupId})`;
      forwardMsg.push(`\n--- ${groupName} (${groupAlarms.length}个任务) ---`);
      for (const alarm of groupAlarms) {
        // (内部逻辑与之前版本相同)
        const setterName = await this.getUserProfile(alarm.setter_id, alarm.group_id);
        const targetName = await this.getUserProfile(alarm.target_id, alarm.group_id);
        let timeDisplay;
        if (alarm.recurrenceRule) {
            const cronParts = alarm.recurrenceRule.split(' ');
            let timeStr;
            if (cronParts.length === 6) {
                const second = cronParts[0].padStart(2, '0');
                const minute = cronParts[1].padStart(2, '0');
                const hour = cronParts[2].padStart(2, '0');
                timeStr = `${hour}:${minute}`;
                if (second !== '00') timeStr += `:${second}`;
            } else {
                const minute = cronParts[0].padStart(2, '0');
                const hour = cronParts[1].padStart(2, '0');
                timeStr = `${hour}:${minute}`;
            }
            timeDisplay = `${alarm.recurrenceText} ${timeStr}`;
        } else {
            timeDisplay = moment(alarm.time).format("MM-DD HH:mm:ss");
        }
        let msg = `[${timeDisplay}] 提醒 ${targetName}(${alarm.target_id})\n创建人：${setterName}(${alarm.setter_id})\n内容：“${alarm.content}”`;
        forwardMsg.push(msg);
      }
    }

    // 2. 接着展示所有私聊的闹钟
    if (privateAlarms.length > 0) {
        forwardMsg.push(`\n--- 私聊闹钟 (${privateAlarms.length}个任务) ---`);
        for (const alarm of privateAlarms) {
            // (内部逻辑与群聊类似，但 getUserProfile 不传 group_id)
            const setterName = await this.getUserProfile(alarm.setter_id);
            const targetName = await this.getUserProfile(alarm.target_id);
             let timeDisplay;
            if (alarm.recurrenceRule) {
                const cronParts = alarm.recurrenceRule.split(' ');
                let timeStr;
                if (cronParts.length === 6) {
                    const second = cronParts[0].padStart(2, '0');
                    const minute = cronParts[1].padStart(2, '0');
                    const hour = cronParts[2].padStart(2, '0');
                    timeStr = `${hour}:${minute}`;
                    if (second !== '00') timeStr += `:${second}`;
                } else {
                    const minute = cronParts[0].padStart(2, '0');
                    const hour = cronParts[1].padStart(2, '0');
                    timeStr = `${hour}:${minute}`;
                }
                timeDisplay = `${alarm.recurrenceText} ${timeStr}`;
            } else {
                timeDisplay = moment(alarm.time).format("MM-DD HH:mm:ss");
            }
            let msg = `[${timeDisplay}] 提醒 ${targetName}(${alarm.target_id})\n创建人：${setterName}(${alarm.setter_id})\n内容：“${alarm.content}”`;
            forwardMsg.push(msg);
        }
    }
    
    await e.reply(await common.makeForwardMsg(e, '全部闹钟队列', forwardMsg));
    return true;
  }

  /**
   * 取消闹钟
   */
  async cancelAlarm(e) {
    const match = e.msg.match(/^#闹钟取消\s*([\d\s]+)$/);
    if (!match) {
      await e.reply('请输入要取消的闹钟序号，例如：#闹钟取消 1 3', true);
      return true;
    }

    const indices = [...new Set(
        match[1].trim().split(/\s+/).map(Number).filter(n => !isNaN(n) && n > 0)
    )].sort((a, b) => a - b);

    if (indices.length === 0) {
      await e.reply('请输入有效的闹钟序号。', true);
      return true;
    }
    
    // --- MODIFIED: 根据场景获取正确的闹钟列表，防止误操作 ---
    const alarms = e.isGroup 
        ? await this.getAlarms({ group_id: e.group_id }) 
        : await this.getAlarms({ user_id: e.user_id });
    
    const successReplies = [];
    const failReplies = [];

    for (const index of indices) {
      if (index > alarms.length) {
        failReplies.push(`序号 [${index}] 不存在。`);
        continue;
      }
      const alarmToCancel = alarms[index - 1];

      if (e.user_id != alarmToCancel.setter_id && !e.isMaster && (!e.member || !e.member.is_admin)) {
        failReplies.push(`序号 [${index}]: 您沒有权限取消。`);
        continue;
      }

      const job = schedule.scheduledJobs[alarmToCancel.key];
      if (job) job.cancel();
      
      await redis.del(alarmToCancel.key);
      logger.info(`[定时闹钟] 已成功从内存和Redis中取消闹钟: ${alarmToCancel.key}`);
      successReplies.push(`[${index}] “${this.truncate(alarmToCancel.content)}”`);
    }

    let finalReply = '';
    if (successReplies.length > 0) {
      finalReply += `成功取消了 ${successReplies.length} 个闹钟：\n` + successReplies.join('\n');
    }
    if (failReplies.length > 0) {
      if (finalReply) finalReply += '\n\n';
      finalReply += `有 ${failReplies.length} 个闹钟取消失败：\n` + failReplies.join('\n');
    }
    if (!finalReply) {
      finalReply = '没有可执行的取消操作，请检查序号。';
    }

    await e.reply(finalReply, true);
    return true;
  }

  /**
   * 辅助函数：截断过长的内容用于显示
   */
  truncate(str, len = 20) {
      if (str.length <= len) {
          return str;
      }
      return str.substring(0, len) + '...';
  }

  /**
   * 插件初始化时，从 Redis 中加载并恢复闹钟
   */
  async restoreAlarmsFromRedis() {
    logger.info('[定时闹钟] 开始从 Redis 恢复闹钟任务 (仅执行一次)...');
    let cursor = 0;
    do {
      try {
        const result = await redis.scan(cursor, {
          MATCH: `${ALARM_REDIS_PREFIX}*`,
          COUNT: 100
        });

        cursor = result.cursor;
        const keys = result.keys;

        if (keys && keys.length > 0) {
          for (const key of keys) {
            try {
              const alarmDataStr = await redis.get(key);
              if (alarmDataStr) {
                const alarmData = JSON.parse(alarmDataStr);
                // --- MODIFIED: 恢复单次闹钟时检查是否过期, 循环闹钟直接恢复 ---
                if (alarmData.recurrenceRule || moment(alarmData.time).isAfter(moment())) {
                  this.scheduleAlarmJob(alarmData);
                  logger.info(`[定时闹钟] 已恢复闹钟: ${alarmData.group_id} - @${alarmData.target_id}`);
                } else {
                  // 删除过期的单次闹钟
                  await redis.del(key);
                  logger.warn(`[定时闹钟] 删除了一个过期的单次闹钟: ${key}`);
                }
              }
            } catch (innerError) {
              logger.error(`[定时闹钟] 处理单个闹钟key失败, key: ${key}, error:`, innerError);
            }
          }
        }
      } catch (scanError) {
        logger.error(`[定时闹钟] Redis scan 操作失败:`, scanError);
        cursor = 0; // 出现错误时终止循环
      }
    } while (cursor !== 0);
    logger.info('[定时闹钟] 所有历史闹钟任务已恢复完毕');
  }

  /**
   * 时间字符串预处理器 (用于单次闹钟)
   */
  preprocessTimeStr(timeStrRaw) {
    let str = timeStrRaw;
    // 预处理，将模糊时间转为精确时间
    str = str.replace(/今晚/g, '今天晚上');
    str = str.replace(/明晚/g, '明天晚上');
    str = str.replace(/后晚/g, '后天晚上');
    str = str.replace(/今早/g, '今天早上');
    str = str.replace(/明早/g, '明天早上');
    str = str.replace(/后早/g, '后天早上');

    str = str.replace(/号/g, '日');
    str = str.replace(/：|点/g, ':');

    let datePart = '';
    let timePart = str;

    const datePatterns = {
      '后天': moment().add(2, 'days'),
      '明天': moment().add(1, 'days'),
      '今天': moment()
    };
    for (const key in datePatterns) {
      if (timePart.includes(key)) {
        datePart = datePatterns[key].format('YYYY-MM-DD');
        timePart = timePart.replace(key, '').trim();
        break;
      }
    }

    if (!datePart) {
      // 优先匹配 YYYY-MM-DD 或 YYYY/MM/DD 格式
      const standardDateMatch = timePart.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
      if (standardDateMatch) {
        const dateStr = standardDateMatch[0];
        datePart = moment(dateStr, "YYYY-MM-DD").format("YYYY-MM-DD");
        timePart = timePart.replace(dateStr, '').trim();
      }
    }

    if (!datePart) {
      const match = timePart.match(/(\d{4}年)?(\d{1,2}月)?(\d{1,2}日)/);
      if (match && match[0]) {
        const dateStr = match[0];
        if (match[1]) {
          datePart = moment(dateStr, "YYYY年M月D日").format("YYYY-MM-DD");
        } else {
          datePart = moment(dateStr, "M月D日").format("YYYY-MM-DD");
        }
        timePart = timePart.replace(dateStr, '').trim();
      } else {
        datePart = moment().format('YYYY-MM-DD');
      }
    }

    timePart = timePart.replace(/中午/g, '12:00');
    timePart = timePart.replace(/半/g, '30');

    let isPM = /下午|晚上/.test(timePart);
    timePart = timePart.replace(/凌晨|早上|上午|下午|晚上/g, '').trim();

    let hour = 0, minute = 0;
    let timeExplicitlySet = false;

    let timeMatch = timePart.match(/(\d{1,2}):(\d{1,2})/);
    if (timeMatch) {
      hour = parseInt(timeMatch[1], 10);
      minute = parseInt(timeMatch[2], 10);
      timeExplicitlySet = true;
    } else {
      timeMatch = timePart.match(/(\d{1,2})/);
      if (timeMatch) {
        hour = parseInt(timeMatch[1], 10);
        timeExplicitlySet = true;
      }
    }

    if (!timeExplicitlySet) {
      hour = 8;
      minute = 0;
    }

    if (isPM && hour >= 1 && hour < 12) {
      hour += 12;
    }

    const finalStr = `${datePart} ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
    return finalStr;
  }
  
  /**
   * NEW: 专门解析时间部分（HH:mm:ss）的辅助函数
   * @param {string} timeStr 时间字符串, 如 "下午3点30分15秒", "8:30:15"
   * @returns {{hour: number, minute: number, second: number}}
   */
  parseTimeOnly(timeStr) {
    let str = timeStr.trim();
    str = str.replace(/：|点/g, ':');
    str = str.replace(/半/g, '30');
    // --- MODIFIED: 增加对'分'和'秒'的转换 ---
    str = str.replace(/分/g, ':').replace(/秒/g, '');

    const isPM = /下午|晚上/.test(str);
    str = str.replace(/凌晨|早上|上午|下午|晚上|中午/g, '').trim();

    // --- MODIFIED: 增加 second 变量 ---
    let hour = 0, minute = 0, second = 0;

    // --- MODIFIED: 优先匹配 H:m:s, 再匹配 H:m, 最后匹配 H ---
    let match = str.match(/(\d{1,2}):(\d{1,2}):(\d{1,2})/); // H:m:s
    if (match) {
        hour = parseInt(match[1], 10);
        minute = parseInt(match[2], 10);
        second = parseInt(match[3], 10);
    } else {
        match = str.match(/(\d{1,2}):(\d{1,2})/); // H:m
        if (match) {
            hour = parseInt(match[1], 10);
            minute = parseInt(match[2], 10);
        } else {
            match = str.match(/(\d{1,2})/); // H
            if (match) {
                hour = parseInt(match[1], 10);
            }
        }
    }

    if (isPM && hour < 12) {
        hour += 12;
    }

    // --- MODIFIED: 返回包含 second 的对象 ---
    return { hour, minute, second };
  }


  /**
   * 设置闹钟 - 第一步：解析时间和提醒对象 (重构以支持循环)
   */
  async setAlarmStep1(e) {
    let target_id = e.user_id;
    if (e.at && e.at !== e.self_id) {
      target_id = e.at;
    }

    let text_content = (e.message || []).filter(s => s.type === 'text').map(s => s.text).join('') || e.raw_message;
    let timeStrRaw = text_content.replace(/^#定时(闹钟)?/, '').trim();

    if (!timeStrRaw) {
      e.reply('请输入正确的时间哦！\n发送 #闹钟帮助 可以查看更多信息。', true);
      return true;
    }
    
    let alarmTime;
    let recurrenceRule = null;
    let recurrenceText = '';
    
    const weekMap = {
      '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '日': 0, '天': 0,
      '1': 1, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 0, '0': 0
    };
    
    const patterns = [
        {
            regex: /^每年(\d{1,2})月(\d{1,2})[日号](.*)/,
            handler: (match) => {
                const month = match[1];
                const day = match[2];
                // --- MODIFIED: 解构出 second ---
                const { hour, minute, second } = this.parseTimeOnly(match[3]);
                recurrenceText = `每年${month}月${day}日`;
                // --- MODIFIED: 生成6位Cron表达式 ---
                return `${second} ${minute} ${hour} ${day} ${month} *`;
            }
        },
        {
            regex: /^每月(\d{1,2})[日号](.*)/,
            handler: (match) => {
                const day = match[1];
                const { hour, minute, second } = this.parseTimeOnly(match[2]);
                recurrenceText = `每月${day}日`;
                return `${second} ${minute} ${hour} ${day} * *`;
            }
        },
        {
            regex: /^每周([一二三四五六日天1-70])(.*)/,
            handler: (match) => {
                const dayInput = match[1];
                const weekDay = weekMap[dayInput];
                const displayMap = { '1': '一', '2': '二', '3': '三', '4': '四', '5': '五', '6': '六', '7': '日', '0': '日' };
                const displayDay = displayMap[dayInput] || dayInput;
                const { hour, minute, second } = this.parseTimeOnly(match[2]);
                recurrenceText = `每周${displayDay}`;
                return `${second} ${minute} ${hour} * * ${weekDay}`;
            }
        },
        {
            regex: /^每[天晚早](.*)/,
            handler: (match) => {
                const { hour, minute, second } = this.parseTimeOnly(match[1]);
                recurrenceText = '每天';
                return `${second} ${minute} ${hour} * * *`;
            }
        }
    ];

    for (const p of patterns) {
        const match = timeStrRaw.match(p.regex);
        if (match) {
            recurrenceRule = p.handler(match);
            break;
        }
    }
    
    if (recurrenceRule) {
      logger.info(`[定时闹钟] 识别为循环任务, Cron: "${recurrenceRule}"`);
      try {
        const job = schedule.scheduleJob('temp-job-for-time-calc', { rule: recurrenceRule, tz: 'Asia/Shanghai' }, () => {});
        if(job && job.nextInvocation()) {
          alarmTime = moment(job.nextInvocation()._date.ts);
          job.cancel();
        } else {
          throw new Error('无法创建临时的schedule任务来计算下次执行时间');
        }
      } catch(err) {
        logger.error(`[定时闹钟] 解析Cron表达式失败: ${recurrenceRule}`, err);
        e.reply('喵... 这个循环时间的格式我还不能完全理解呢。', true);
        return true;
      }
    } else {
      let isRelative = false;
      let processedTimeStr = timeStrRaw.replace(/一个半小时/g, '90分钟').replace(/半小时/g, '30分钟').replace(/一刻钟/g, '15分钟');
      
      const minuteMatch = processedTimeStr.match(/(\d+)\s*分钟后/);
      if (minuteMatch) {
        alarmTime = moment().add(parseInt(minuteMatch[1]), 'minutes');
        isRelative = true;
      } else {
        const hourMatch = processedTimeStr.match(/(\d+)\s*小时后/);
        if (hourMatch) {
          alarmTime = moment().add(parseInt(hourMatch[1]), 'hours');
          isRelative = true;
        }
      }

      if (!isRelative) {
        const timeStr = this.preprocessTimeStr(timeStrRaw);
        logger.info(`[定时闹钟] 时间解析: "${timeStrRaw}" -> "${timeStr}"`);
        alarmTime = moment.tz(timeStr, 'YYYY-MM-DD HH:mm:ss', true, 'Asia/Shanghai');
      } else {
        logger.info(`[定时闹钟] 识别为相对时间: "${timeStrRaw}"`);
      }
    }

    if (!alarmTime || !alarmTime.isValid()) {
      e.reply('喵... 这个时间格式我还不能完全理解呢。\n请试试 "每天下午3点" 或 "10分钟后" 这样的格式哦~\n发送 #闹钟详细帮助 查看更多示例。', true);
      return true;
    }

    if (alarmTime.isBefore(moment())) {
      if (!recurrenceRule) {
          e.reply('不能设置一个过去的时间哦，我们没法穿越回去啦~', true);
          return true;
      }
    }

    if (!e.context) e.context = {};
    e.context.alarmData = {
      alarmTime: alarmTime.toISOString(),
      target_id: target_id,
      recurrenceRule: recurrenceRule,
      recurrenceText: recurrenceText,
    };

    this.setContext('setAlarmStep2', e, 120);

    let promptMsg = (target_id === e.user_id)
      ? '好的，时间已收到！\n请问你要设置什么事情的闹钟提醒呢？'
      : ['好的，时间已收到！\n请问你要提醒 ', segment.at(target_id), ' 什么事呢？'];
      
    await e.reply(promptMsg, true);
    return true;
  }

  /**
   * 设置闹钟 - 第二步：获取提醒内容并创建任务
   */
  async setAlarmStep2(e) {
    // 从上下文中获取所有数据
    const { alarmTime, target_id, recurrenceRule, recurrenceText } = e.context.alarmData;
    const content = this.e.raw_message.trim();

    this.finish('setAlarmStep2', e);

    if (!content) {
      e.reply('闹钟内容不能为空哦，设置失败了。', true);
      return true;
    }

    const alarmData = {
      setter_id: this.e.user_id,
      target_id: target_id,
      // --- MODIFIED: 关键修改 ---
      // 判断是否为群聊消息，如果是，则记录 group_id，否则记录 null
      group_id: this.e.isGroup ? this.e.group_id : null,
      content: content,
      time: alarmTime, // 下一次触发时间
      key: `${ALARM_REDIS_PREFIX}${moment().unix()}:${this.e.user_id}:${Math.random()}`,
      recurrenceRule: recurrenceRule, // 循环规则
      recurrenceText: recurrenceText  // 循环文本
    };

    try {
      // 对于循环任务，让它永不过期；对于单次任务，设置一个合理的过期时间
      const redisOptions = recurrenceRule ? {} : { EX: moment(alarmTime).diff(moment(), 'seconds') + 300 };
      await redis.set(alarmData.key, JSON.stringify(alarmData), redisOptions);
      this.scheduleAlarmJob(alarmData);
      
      const timePart = recurrenceRule ? `${recurrenceText} ${moment(alarmTime).format('HH:mm:ss')}` : moment(alarmTime).format('YYYY年MM月DD日 HH:mm:ss');
      
      // --- MODIFIED: 优化回复消息 ---
      // 在私聊中，提醒对象就是自己，无需再@
      const targetSegment = this.e.isGroup ? segment.at(target_id) : '你';

      const replyMsg = [
        '喵~ 闹钟设置好啦！\n我会在 ',
        timePart,
        `\n提醒 `,
        targetSegment,
        `：“${content}”`
      ];
      await e.reply(replyMsg, true);

    } catch (error) {
      logger.error('[定时闹钟] 创建闹钟任务失败:', error);
      await e.reply('抱歉，闹钟设置失败了，请稍后再试。', true);
    }
    return true;
  }

  /**
   * 核心函数：创建一个 schedule 任务 (适配循环和单次)
   */
  scheduleAlarmJob(alarmData) {
    // 闹钟触发时执行的核心逻辑
    const jobFunction = async () => {
      try {
        // --- MODIFIED: 关键修改 ---
        // 定义一个联系人变量，可以是群，也可以是好友
        let contact; 
        
        if (alarmData.group_id) {
          // 如果 group_id 存在，说明是群聊闹钟
          contact = Bot.pickGroup(alarmData.group_id);
        } else {
          // 如果 group_id 为 null，说明是私聊闹钟
          contact = Bot.pickUser(alarmData.target_id);
        }

        if (contact) {
          let msg = [];
          // 如果是群聊，需要 @ 提醒对象；私聊则不需要
          if (alarmData.group_id) {
            msg.push(segment.at(alarmData.target_id));
          }
          msg.push(` 叮咚！闹钟时间到啦！\n${alarmData.content}`);
          
          await contact.sendMsg(msg);
          logger.info(`[定时闹钟] 已成功触发闹钟: ${alarmData.group_id || `好友(${alarmData.target_id})`}`);
          
          // 如果是循环任务, 更新下一次触发时间到Redis
          if(alarmData.recurrenceRule) {
             const job = schedule.scheduledJobs[alarmData.key];
             if(job && job.nextInvocation()) {
                 alarmData.time = job.nextInvocation().toISOString();
                 // 使用 set 而不是 psetex 来确保持久化
                 await redis.set(alarmData.key, JSON.stringify(alarmData));
             }
          }
        } else {
            logger.warn(`[定时闹钟] 无法找到联系人来发送闹钟提醒, GroupID: ${alarmData.group_id}, UserID: ${alarmData.target_id}`);
        }
      } catch (error) {
        logger.error(`[定时闹钟] 发送提醒消息失败:`, error);
      }
    };

    // 根据闹钟类型选择不同的调度方式
    if (alarmData.recurrenceRule) {
      // --- 循环任务 ---
      schedule.scheduleJob(alarmData.key, { rule: alarmData.recurrenceRule, tz: 'Asia/Shanghai' }, jobFunction);
      logger.info(`[定时闹钟] 已成功调度一个[循环]闹钟, 规则: ${alarmData.recurrenceRule}, 对象: ${alarmData.target_id}`);
    } else {
      // --- 单次任务 ---
      schedule.scheduleJob(alarmData.key, new Date(alarmData.time), async () => {
        await jobFunction();
        // 单次任务执行完毕后，从Redis中删除
        await redis.del(alarmData.key);
      });
      logger.info(`[定时闹钟] 已成功调度一个[单次]闹钟, 时间: ${alarmData.time}, 对象: ${alarmData.target_id}`);
    }
  }
}
