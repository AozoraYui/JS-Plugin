import { segment } from "oicq";
import plugin from '../../lib/plugins/plugin.js';
import common from '../../lib/common/common.js';
import puppeteer from '../../lib/puppeteer/puppeteer.js'; // 【新增】引入 Yunzai 的浏览器渲染核心
import fetch from 'node-fetch';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import fs from 'fs';
import path from 'path';

// 确保插件数据目录、JSON 数据和临时 HTML 存放的目录存在
const noticeDataDir = path.join(process.cwd(), 'data', 'Notice_Plugin');
const atDataDir = path.join(noticeDataDir, 'whoAtMe');
const atMediaDir = path.join(atDataDir, 'media');
const calledDataDir = path.join(noticeDataDir, 'whoCalledMe');
const aliasDataDir = path.join(noticeDataDir, 'Alias');
const notifyDataDir = path.join(noticeDataDir, 'NotifySettings');
const getAliasFilePath = userId => path.join(aliasDataDir, `${String(userId)}_aliases.json`);
const getNotifyFilePath = userId => path.join(notifyDataDir, `${String(userId)}.json`);
const aliasMaxLength = 32;
const forwardUserLimit = 20;
const forwardCharLimit = 5000;
const reservedAliasWords = new Set([
    '外号设置',
    '设置外号',
    'alias',
    '外号帮助',
    'alias帮助',
    '外号删除',
    '我的外号',
    '查看外号',
    '查看全部外号',
    '谁艾特我',
    '谁叫我了',
    '谁叫他了',
    '谁叫她了',
    '谁叫它了',
    '清除艾特数据',
    '清除全部艾特数据',
    '外号提醒开启',
    '外号提醒关闭',
    '艾特提醒开启',
    '艾特提醒关闭',
    '自艾特提醒开启',
    '自艾特提醒关闭'
]);

if (!fs.existsSync(atDataDir)) {
    fs.mkdirSync(atDataDir, { recursive: true });
}
if (!fs.existsSync(atMediaDir)) {
    fs.mkdirSync(atMediaDir, { recursive: true });
}
if (!fs.existsSync(calledDataDir)) {
    fs.mkdirSync(calledDataDir, { recursive: true });
}
if (!fs.existsSync(aliasDataDir)) {
    fs.mkdirSync(aliasDataDir, { recursive: true });
}
if (!fs.existsSync(notifyDataDir)) {
    fs.mkdirSync(notifyDataDir, { recursive: true });
}

function cleanAlias(value) {
    return String(value ?? '')
        .normalize('NFKC')
        .trim()
        .replace(/\s+/g, ' ');
}

function aliasKey(value) {
    return cleanAlias(value).toLowerCase();
}

function readAliasFile(userId) {
    const filePath = getAliasFilePath(userId);
    if (!fs.existsSync(filePath)) return [];

    try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        const aliases = Array.isArray(data) ? data : data?.aliases;
        if (!Array.isArray(aliases)) return [];

        const result = [];
        const keys = new Set();
        for (const item of aliases) {
            const alias = cleanAlias(item);
            const key = aliasKey(alias);
            if (!alias || keys.has(key)) continue;
            keys.add(key);
            result.push(alias);
        }
        return result;
    } catch (err) {
        logger.error(`外号配置读取失败：${filePath}`, err);
        return [];
    }
}

function writeAliasFile(userId, aliases) {
    const filePath = getAliasFilePath(userId);
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    const data = {
        user_id: String(userId),
        aliases,
        updated_at: Date.now()
    };

    fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tempPath, filePath);
}

function deleteAliasFile(userId) {
    const filePath = getAliasFilePath(userId);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
}

function readAllAliasFiles() {
    let fileNames = [];
    try {
        fileNames = fs.readdirSync(aliasDataDir);
    } catch (err) {
        logger.error('外号目录读取失败', err);
        return [];
    }

    const entries = [];
    for (const fileName of fileNames) {
        const match = fileName.match(/^(\d+)_aliases\.json$/);
        if (!match) continue;

        const userId = match[1];
        const aliases = readAliasFile(userId);
        if (aliases.length > 0) entries.push({ userId, aliases });
    }

    return entries.sort((left, right) =>
        left.userId.localeCompare(right.userId, undefined, { numeric: true })
    );
}

function getNotifySettings(userId) {
    const defaults = {
        user_id: String(userId),
        alias_notify: false,
        mention_notify: false,
        self_mention_notify: false
    };
    const filePath = getNotifyFilePath(userId);
    if (!fs.existsSync(filePath)) return defaults;

    try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        return {
            ...defaults,
            alias_notify: data?.alias_notify === true,
            mention_notify: data?.mention_notify === true,
            self_mention_notify: data?.self_mention_notify === true
        };
    } catch (err) {
        logger.error(`提醒配置读取失败：${filePath}`, err);
        return defaults;
    }
}

function writeNotifySettings(userId, settings) {
    const filePath = getNotifyFilePath(userId);
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    const data = {
        user_id: String(userId),
        alias_notify: settings.alias_notify === true,
        mention_notify: settings.mention_notify === true,
        self_mention_notify: settings.self_mention_notify === true,
        updated_at: Date.now()
    };

    fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tempPath, filePath);
}

function getNotifySettingKey(type) {
    return {
        '外号提醒': 'alias_notify',
        '艾特提醒': 'mention_notify',
        '自艾特提醒': 'self_mention_notify'
    }[type];
}

function updateNotifySetting(userId, type, enabled) {
    const key = getNotifySettingKey(type);
    if (!key) return null;

    const settings = getNotifySettings(userId);
    settings[key] = enabled;
    writeNotifySettings(userId, settings);
    return settings;
}

function formatNotifyStatus(settings) {
    const status = value => value ? '开启' : '关闭';
    return [
        `外号提醒：${status(settings.alias_notify)}`,
        `艾特提醒：${status(settings.mention_notify)}`,
        `自艾特提醒：${status(settings.self_mention_notify)}`
    ];
}

function splitForwardMessages(messages) {
    const chunks = [];
    let current = [];
    let currentLength = 0;

    for (const message of messages) {
        const messageLength = String(message).length;
        if (current.length > 0 && (
            current.length >= forwardUserLimit ||
            currentLength + messageLength > forwardCharLimit
        )) {
            chunks.push(current);
            current = [];
            currentLength = 0;
        }

        current.push(message);
        currentLength += messageLength;
    }

    if (current.length > 0) chunks.push(current);
    return chunks;
}

function validateAlias(alias) {
    const cleanedAlias = cleanAlias(alias);
    const key = aliasKey(cleanedAlias);

    if (!cleanedAlias) return '外号不能为空哦~';
    if (cleanedAlias.length > aliasMaxLength) {
        return `外号不能超过 ${aliasMaxLength} 个字符哦~`;
    }
    if (/\r|\n/.test(cleanedAlias)) return '外号不能包含换行哦~';
    if ([...reservedAliasWords].some(word => key.includes(aliasKey(word)))) {
        return '这个外号与插件命令冲突，请换一个吧~';
    }
    return '';
}

function isAliasCommand(text) {
    return /^#?(外号设置|外号删除|我的外号|查看外号|查看全部外号|设置外号|alias|外号帮助|外号提醒(?:\s*(?:开启|关闭|开|关))?|艾特提醒(?:\s*(?:开启|关闭|开|关))?|自艾特提醒(?:\s*(?:开启|关闭|开|关))?|设置(?:外号提醒|艾特提醒|自艾特提醒)(?:\s+.*)?|谁叫(我|他|她|它)了|谁(艾特|@|at)(我|他|她|它)|(哪个逼|哪个扑街仔|哪个铺盖仔|哪个扑街|哪个铺盖|哪个屌毛|哪个叼毛)(艾特|@|at)我)/i.test(cleanAlias(text));
}

function saveAliasForUser(userId, alias) {
    const cleanedAlias = cleanAlias(alias);
    const validationMessage = validateAlias(cleanedAlias);
    if (validationMessage) return { success: false, message: validationMessage };

    const normalizedUserId = String(userId);
    const aliases = readAliasFile(normalizedUserId);
    const aliasKeyValue = aliasKey(cleanedAlias);
    if (aliases.some(item => aliasKey(item) === aliasKeyValue)) {
        return { success: false, message: `外号“${cleanedAlias}”已经设置过了哦~` };
    }

    const conflict = readAllAliasFiles().find(entry =>
        entry.userId !== normalizedUserId && entry.aliases.some(item => aliasKey(item) === aliasKeyValue)
    );
    if (conflict) {
        return { success: false, message: `外号“${cleanedAlias}”已经被其他用户使用了，请换一个吧~` };
    }

    try {
        writeAliasFile(normalizedUserId, [...aliases, cleanedAlias]);
        return { success: true, message: `✅ 外号“${cleanedAlias}”设置成功！` };
    } catch (err) {
        logger.error(`外号保存失败：${normalizedUserId}`, err);
        return { success: false, message: '外号保存失败，请稍后再试~' };
    }
}

// ⏳ 辅助函数：计算时间差
function formatTime(timestamp) {
    const now = Date.now();
    const diff = Math.floor((now - timestamp) / 1000); // 换算为秒
    
    const date = new Date(timestamp);
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');
    const timeStr = `${hours}:${minutes}:${seconds}`;

    if (diff < 60) return `刚刚 (${timeStr})`;
    if (diff < 3600) return `${Math.floor(diff / 60)}分钟前 (${timeStr})`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}小时前 (${timeStr})`;
    
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${month}-${day} ${timeStr}`;
}

function formatDateTime(timestamp) {
    const date = new Date(Number(timestamp) || Date.now());
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');
    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

function getReplyImageSegments(reply) {
    return (Array.isArray(reply?.images) ? reply.images : [])
        .map(getImageValue)
        .filter(Boolean)
        .map(image => segment.image(image));
}

function getCalledFilePath(userId) {
    return path.join(calledDataDir, `${String(userId)}.json`);
}

function readCalledRecords(userId) {
    const filePath = getCalledFilePath(userId);
    if (!fs.existsSync(filePath)) return [];

    try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (Array.isArray(data)) return data;
        if (Array.isArray(data?.records)) return data.records;
        return [];
    } catch (err) {
        logger.error(`外号呼叫记录读取失败：${filePath}`, err);
        return [];
    }
}

function appendCalledRecord(userId, record) {
    const filePath = getCalledFilePath(userId);
    const records = readCalledRecords(userId);
    records.push(record);
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    const data = {
        user_id: String(userId),
        records,
        updated_at: Date.now()
    };

    fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tempPath, filePath);
}

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function getImageValue(value) {
    if (typeof value === 'string') return value;
    return value?.url || value?.data?.url || value?.file || value?.data?.file || '';
}

function getCachedImagePath(url) {
    const hash = createHash('sha256').update(String(url)).digest('hex');
    return path.join(atMediaDir, `${hash}.img`);
}

async function cacheImageUrl(value) {
    const imageUrl = getImageValue(value);
    if (!/^https?:\/\//i.test(imageUrl)) return imageUrl;

    const cachePath = getCachedImagePath(imageUrl);
    if (!fs.existsSync(cachePath)) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15000);
        try {
            const response = await fetch(imageUrl, { signal: controller.signal });
            if (!response.ok) return imageUrl;
            const buffer = Buffer.from(await response.arrayBuffer());
            if (!buffer.length) return imageUrl;
            fs.writeFileSync(cachePath, buffer);
        } catch (err) {
            logger.debug?.(`图片缓存失败：${imageUrl}，${err.message}`);
            return imageUrl;
        } finally {
            clearTimeout(timeout);
        }
    }

    return pathToFileURL(cachePath).href;
}

async function cacheRecordImages(records) {
    let changed = false;
    for (const record of records) {
        for (const key of ['image']) {
            if (!Array.isArray(record?.[key])) continue;
            for (let index = 0; index < record[key].length; index++) {
                const original = getImageValue(record[key][index]);
                if (!original) continue;
                const cached = await cacheImageUrl(original);
                if (cached && cached !== original) {
                    record[key][index] = cached;
                    changed = true;
                }
            }
        }

        const replyImages = record?.reply?.images;
        if (Array.isArray(replyImages)) {
            for (let index = 0; index < replyImages.length; index++) {
                const original = getImageValue(replyImages[index]);
                if (!original) continue;
                const cached = await cacheImageUrl(original);
                if (cached && cached !== original) {
                    replyImages[index] = cached;
                    changed = true;
                }
            }
        }
    }
    return changed;
}

function getMessageSegmentValue(segment, key) {
    return segment?.[key] ?? segment?.data?.[key];
}

function getMessageText(message) {
    const parts = [];
    for (const segment of Array.isArray(message) ? message : []) {
        const type = segment?.type;
        if (type === 'text') {
            parts.push(String(getMessageSegmentValue(segment, 'text') ?? ''));
        } else if (type === 'at') {
            const qq = String(getMessageSegmentValue(segment, 'qq') ?? '').trim();
            const display = getMessageSegmentValue(segment, 'text');
            parts.push(String(display ?? (qq.toLowerCase() === 'all' ? '@全体成员' : `@${qq}`)));
        } else if (type === 'face') {
            parts.push('[表情]');
        } else if (type === 'image') {
            parts.push('[图片]');
        } else if (type === 'record') {
            parts.push('[语音]');
        } else if (type === 'video') {
            parts.push('[视频]');
        } else if (type === 'file') {
            parts.push('[文件]');
        }
    }
    return parts.join('').trim();
}

function getMessageImages(message) {
    return (Array.isArray(message) ? message : [])
        .filter(segment => segment?.type === 'image')
        .map(segment => getImageValue(getMessageSegmentValue(segment, 'url') || segment))
        .filter(Boolean)
        .map(String);
}

function getActorDisplay(e) {
    const name = e.sender?.card || e.sender?.nickname || e.nickname || String(e.user_id);
    return `${name}（QQ：${String(e.user_id)}）`;
}

function canManageOtherUser(e) {
    return Boolean(e.isMaster || e.member?.is_admin || e.member?.is_owner);
}

function sourceNameFallback(userId) {
    return userId || '引用消息';
}

async function getReplySnapshot(e) {
    let source = null;
    if (typeof e.getReply === 'function') {
        source = await e.getReply();
    } else if (e.source && e.group?.getChatHistory) {
        const historyKey = e.source.seq ?? e.source.id ?? e.source.message_id;
        if (historyKey !== undefined) {
            source = (await e.group.getChatHistory(historyKey, 1))?.pop();
        }
    }

    if (Array.isArray(source)) source = source.pop();
    if (!source) return null;

    const sourceMessage = Array.isArray(source.message) ? source.message : [];
    const sourceUserId = String(
        source.user_id ??
        source.sender?.user_id ??
        source.sender?.uin ??
        source.sender?.id ??
        e.source?.user_id ??
        ''
    ).replace(/[^0-9]/g, '');
    const sourceName = String(
        source.sender?.card ??
        source.sender?.nickname ??
        source.nickname ??
        sourceNameFallback(sourceUserId)
    );
    const sourceText = getMessageText(sourceMessage) ||
        String(source.raw_message ?? '').replace(/\[CQ:[^\]]+\]/g, '').trim() ||
        '纯媒体消息';

    return {
        messageId: String(source.message_id ?? source.id ?? e.source?.seq ?? e.source?.id ?? ''),
        userId: sourceUserId,
        name: sourceName,
        text: sourceText,
        images: await Promise.all(getMessageImages(sourceMessage).map(cacheImageUrl))
    };
}

async function notifyMentionedUsers(e, targetQQs, directAtQQs, msgData) {
    const source = e.group_name ? `${e.group_name}(${e.group_id})` : String(e.group_id);
    const directTargets = new Set(directAtQQs.map(String));
    const replyTarget = String(msgData.reply?.userId || '');

    await Promise.allSettled(targetQQs.map(async targetQQ => {
        const normalizedTargetQQ = String(targetQQ);
        if (!/^\d+$/.test(normalizedTargetQQ) || normalizedTargetQQ === String(Bot.uin)) return;

        const isSelfTarget = normalizedTargetQQ === String(e.user_id);
        const settings = getNotifySettings(normalizedTargetQQ);
        const notifyEnabled = isSelfTarget
            ? settings.self_mention_notify
            : settings.mention_notify;
        if (!notifyEnabled) return;

        const isDirectAt = directTargets.has(normalizedTargetQQ);
        const isReplyTarget = replyTarget === normalizedTargetQQ;
        let actionText = '有人在群';
        if (isDirectAt && isReplyTarget) actionText += '艾特并引用了你的消息';
        else if (isDirectAt) actionText += '艾特了你';
        else if (isReplyTarget) actionText += '引用了你的消息';
        else actionText += '提到了你';

        const privateText = [
            `${actionText}「${source}」\n`,
            `触发人：${getActorDisplay(e)}\n`,
            `时间：${formatDateTime(msgData.timestamp)}\n`
        ];
        if (msgData.reply?.text) {
            privateText.push(`引用内容：${msgData.reply.text}\n`);
        }
        const replyImages = getReplyImageSegments(msgData.reply);
        const privateMessage = [
            ...privateText,
            ...(replyImages.length > 0 ? ['引用图片：', ...replyImages] : []),
            `消息：${msgData.message || '纯艾特'}`
        ];

        try {
            await Bot.pickUser(Number(normalizedTargetQQ)).sendMsg(privateMessage);
        } catch (err) {
            logger.warn(`艾特/引用私聊提醒发送失败：${normalizedTargetQQ}`, err);
            if (replyImages.length > 0) {
                try {
                    await Bot.pickUser(Number(normalizedTargetQQ)).sendMsg([
                        ...privateText,
                        '引用图片发送失败，已保留文字内容。\n',
                        `消息：${msgData.message || '纯艾特'}`
                    ]);
                } catch (fallbackErr) {
                    logger.warn(`艾特/引用文字私聊提醒发送失败：${normalizedTargetQQ}`, fallbackErr);
                }
            }
        }
    }));
}

function buildAliasCalledHtml(records, pageNumber, totalPages, totalRecords, targetLabel = '') {
    const msgHtml = records.map(record => {
        const callerId = String(record.caller_id || '').replace(/[^0-9]/g, '') || '0';
        const callerName = escapeHtml(record.caller_name || callerId);
        const aliases = escapeHtml(Array.isArray(record.aliases) ? record.aliases.join('、') : record.alias || '');
        const message = escapeHtml(record.message || '纯外号呼叫').replace(/\n/g, '<br>');
        const source = escapeHtml(record.group || record.group_id || '未知群聊');

        return `
            <div class="msg-item">
                <img class="avatar" src="https://q1.qlogo.cn/g?b=qq&nk=${callerId}&s=100">
                <div class="msg-content">
                    <div class="sender-info">
                        <span class="sender-name">${callerName}</span>
                        <span class="msg-time">${formatTime(record.timestamp)}</span>
                    </div>
                    <div class="source">${source} · 呼叫外号：${aliases}</div>
                    <div class="bubble">${message}</div>
                </div>
            </div>`;
    }).join('');

    const pageText = totalPages > 1 ? `（第 ${pageNumber}/${totalPages} 页）` : '';
    const title = targetLabel ? `${escapeHtml(targetLabel)}外号呼叫记录` : '外号呼叫记录';
    return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<style>
:root { --theme-color: #7b8cf6; --bg-gradient: linear-gradient(135deg, #eef2fb 0%, #e0e7ff 100%); }
* { box-sizing: border-box; }
body { font-family: 'PingFang SC', sans-serif; background: var(--bg-gradient); margin: 0; padding: 32px; width: 760px; color: #374151; }
.container { background: rgba(255, 255, 255, 0.94); border-radius: 20px; padding: 28px; box-shadow: 0 10px 30px rgba(112, 128, 176, 0.15); border: 1px solid white; }
.header { display: flex; align-items: center; padding-bottom: 20px; margin-bottom: 20px; border-bottom: 2px dashed #e5e7eb; }
.header-icon { width: 58px; height: 58px; border-radius: 50%; margin-right: 16px; background: #eef2ff; display: flex; align-items: center; justify-content: center; font-size: 28px; }
.header-info h2 { margin: 0 0 5px 0; font-size: 23px; color: #1f2937; }
.header-info p { margin: 0; font-size: 14px; color: #6b7280; }
.header-info strong { color: var(--theme-color); }
.msg-list { display: flex; flex-direction: column; gap: 16px; }
.msg-item { display: flex; gap: 13px; }
.avatar { width: 42px; height: 42px; border-radius: 12px; object-fit: cover; flex: 0 0 auto; }
.msg-content { flex: 1; min-width: 0; }
.sender-info { display: flex; align-items: center; gap: 10px; margin-bottom: 3px; }
.sender-name { font-weight: 600; font-size: 15px; color: #374151; }
.msg-time { font-size: 12px; color: #9ca3af; }
.source { font-size: 12px; color: #9ca3af; margin-bottom: 5px; }
.bubble { background: #fff; padding: 10px 13px; border-radius: 0 13px 13px 13px; font-size: 14px; line-height: 1.45; box-shadow: 0 2px 8px rgba(0,0,0,0.04); border: 1px solid #f3f4f6; word-break: break-word; }
.footer { margin-top: 24px; text-align: center; color: #cbd5e1; font-size: 12px; }
</style>
</head>
<body>
<div class="container">
    <div class="header">
        <div class="header-icon">📣</div>
        <div class="header-info">
            <h2>${title} ${pageText}</h2>
            <p>当前群共 <strong>${totalRecords}</strong> 条历史呼叫记录</p>
        </div>
    </div>
    <div class="msg-list">${msgHtml}</div>
    <div class="footer">Generated by 外号提醒插件 • ${new Date().toLocaleString()}</div>
</div>
</body>
</html>`;
}

export class noticePlugin extends plugin {
    constructor() {
        super({
            name: '外号提醒 & 艾特助手',
            dsc: '外号提醒、艾特记录查询、外号呼叫记录查询',
            event: 'message',
            priority: -114514, 
            rule: [
                { reg: '^#?(alias/外号帮助|外号帮助|alias帮助)$', fnc: 'aliasHelp' },
                { reg: '^#?(?:设置)?(?:外号提醒|艾特提醒|自艾特提醒)(?:\\s+.*)?(?:开启|关闭|开|关)$', fnc: 'setNotifyPreference' },
                { reg: '^#?(?:外号设置|设置外号|alias)(/(?:alias|外号))?(\\s+.*)?$', fnc: 'setAliasForUser' },
                { reg: '^#?外号删除\\s*.+$', fnc: 'removeAlias' },
                { reg: '^#?查看外号(?:\\s+.*)?$', fnc: 'viewAliases' },
                { reg: '^#?我的外号$', fnc: 'viewAliases' },
                { reg: '^#?查看全部外号$', fnc: 'allAliases', permission: 'master' },
                { reg: '^#?谁叫(我|他|她|它)了$', fnc: 'whoCalledMe' },
                { reg: '^(谁(艾特|@|at)(我|他|她|它)|(哪个逼|哪个扑街仔|哪个铺盖仔|哪个扑街|哪个铺盖|哪个屌毛|哪个叼毛)(艾特|@|at)我)$', fnc: 'whoAtme' },
                { reg: '^(/clear_at|清除(艾特|at)数据)$', fnc: 'clearAt' },
                { reg: '^(/clear_all|清除全部(艾特|at)数据)$', fnc: 'clearAll', permission: 'master' }
            ]
        });
    }

    // =========================================================
    // 【模块一：监听所有的 @ 消息（稳定版逻辑）】
    // =========================================================
    async accept(e) {
        const isPluginCommand = e.isGroup && e.msg && isAliasCommand(e.msg);
        if (e.isGroup && e.msg && !isPluginCommand) {
            await this.aliasNotice(e);
        }
        if (isPluginCommand || !e.isGroup || !e.message) return false;

        let imgUrls = [];
        let faceId = [];
        let AtQQ = [];
        let hasAtAll = false;
        let hasVoice = false, hasVideo = false, hasCard = false;
        const rawMessage = String(e.raw_message ?? e.msg ?? '');
        let isReply = !!e.source;

        for (let msg of (Array.isArray(e.message) ? e.message : [])) {
            if (msg.type === 'at') {
                const targetQQ = String(msg.qq ?? msg.data?.qq ?? '').trim();
                if (targetQQ.toLowerCase() === 'all') {
                    hasAtAll = true;
                } else if (/^\d+$/.test(targetQQ)) {
                    AtQQ.push(targetQQ);
                }
            }
            if (msg.type === 'reply') isReply = true;
            if (msg.type === 'image') imgUrls.push(getImageValue(msg));
            if (msg.type === 'face') faceId.push(msg.id);
            if (msg.type === 'record') hasVoice = true;
            if (msg.type === 'video') hasVideo = true;
            if (msg.type === 'json' || msg.type === 'xml') hasCard = true;
        }

        // 部分适配器会把引用消息中的 CQ 码保留在 raw_message，
        // 但没有完整转换到 e.message，因此这里补充解析一次。
        for (const match of rawMessage.matchAll(/\[CQ:at,[^\]]*qq=([^,\]]+)/gi)) {
                const targetQQ = String(match[1] ?? '').trim();
                if (targetQQ.toLowerCase() === 'all') {
                    hasAtAll = true;
                } else if (/^\d+$/.test(targetQQ)) {
                    AtQQ.push(targetQQ);
                }
        }
        if (!isReply && /\[CQ:reply(?:,|\])/i.test(rawMessage)) isReply = true;

        const directAtQQs = [...new Set(AtQQ)].filter(targetQQ => targetQQ !== String(Bot.uin));
        let replySnapshot = null;
        if (isReply) {
            try {
                replySnapshot = await getReplySnapshot(e);
            } catch (err) {
                logger.debug?.(`引用消息读取失败：${err.message}`);
            }
        }

        const replyTargetQQ = /^\d+$/.test(String(replySnapshot?.userId || ''))
            ? String(replySnapshot.userId)
            : '';
        AtQQ = [...new Set([...directAtQQs, replyTargetQQ])]
            .filter(targetQQ => /^\d+$/.test(targetQQ) && targetQQ !== String(Bot.uin));

        // 记录真实的数字 QQ 艾特、@全体，或被引用消息的作者。
        if (!AtQQ.length && !hasAtAll) return false;

        imgUrls = await Promise.all(imgUrls.filter(Boolean).map(cacheImageUrl));

        const timestamp = Date.now();
        const msgData = {
            User: e.user_id,
            targetQQs: AtQQ,
            isAtAll: hasAtAll,
            message: rawMessage.replace(/\[(.*?)\]/g, '').trim(),
            image: imgUrls,
            name: e.nickname || e.sender?.card || String(e.user_id),
            faceId: faceId,
            time: e.time,
            timestamp: timestamp,
            isReply: isReply,
            reply: replySnapshot,
            hasVoice, hasVideo, hasCard 
        };

        const filePath = path.join(atDataDir, `${e.group_id}.json`);
        let groupData = {};
        if (fs.existsSync(filePath)) {
            try { groupData = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch (err) {}
        }

        if (hasAtAll) {
            groupData['all'] = groupData['all'] || [];
            groupData['all'].push(msgData);
        }
        for (const targetQQ of AtQQ) {
            const targetKey = String(targetQQ);
            groupData[targetKey] = groupData[targetKey] || [];
            groupData[targetKey].push(msgData);
        }
        fs.writeFileSync(filePath, JSON.stringify(groupData, null, 2), 'utf8');

        if (AtQQ.length > 0) {
            await notifyMentionedUsers(e, AtQQ, directAtQQs, msgData);
        }
        return false; 
    }


    // =========================================================
    // 【模块二：外号呼叫与艾特记录查询】
    // =========================================================
    async whoCalledMe(e) {
        if (!e.isGroup) {
            await e.reply('此功能仅限群聊使用哦~', true);
            return true;
        }

        const commandText = cleanAlias(e.msg || '');
        const commandMatch = commandText.match(/^#?谁叫(我|他|她|它)了/i);
        const targetPronoun = commandMatch?.[1] || '我';
        const isSelf = targetPronoun === '我';
        let targetUserId = String(e.user_id);

        if (!isSelf) {
            if (!e.at || e.atBot) {
                await e.reply(`用法：谁叫${targetPronoun}了 @用户`, true);
                return true;
            }
            targetUserId = String(e.at);
        }

        let targetName = isSelf ? '我' : targetUserId;
        if (!isSelf && e.group?.pickMember) {
            const member = e.group.pickMember(targetUserId);
            targetName = member?.card || member?.nickname || targetUserId;
        }

        const records = readCalledRecords(targetUserId)
            .filter(record => String(record.group_id) === String(e.group_id))
            .sort((left, right) => (right.timestamp || 0) - (left.timestamp || 0));

        if (records.length === 0) {
            await e.reply(
                isSelf
                    ? '目前没有人在本群呼叫过你的外号哦~'
                    : `目前没有人在本群呼叫过${targetName}的外号哦~`,
                true
            );
            return true;
        }

        const pageSize = 16;
        const totalPages = Math.ceil(records.length / pageSize);
        const imageMessages = [];
        const renderId = `${e.group_id}_${targetUserId}_${Date.now()}`;
        const targetLabel = isSelf ? '我的' : `${targetName}的`;

        for (let index = 0; index < records.length; index += pageSize) {
            const pageNumber = Math.floor(index / pageSize) + 1;
            const pageRecords = records.slice(index, index + pageSize);
            const htmlPath = path.join(
                calledDataDir,
                `temp_render_${renderId}_${pageNumber}.html`
            );
            const htmlString = buildAliasCalledHtml(
                pageRecords,
                pageNumber,
                totalPages,
                records.length,
                targetLabel
            );

            fs.writeFileSync(htmlPath, htmlString, 'utf8');
            try {
                const image = await puppeteer.screenshot(
                    `whoCalledMe_${renderId}_${pageNumber}`,
                    { tplFile: htmlPath, data: {} }
                );
                if (image) imageMessages.push(image);
            } catch (err) {
                logger.error(`外号呼叫记录第 ${pageNumber} 页渲染失败`, err);
            }
        }

        if (imageMessages.length === 0) {
            await e.reply('外号呼叫记录图片生成失败，请稍后再试~', true);
            return true;
        }

        if (imageMessages.length === 1) {
            await e.reply(imageMessages[0]);
            return true;
        }

        const forwardMsg = await common.makeForwardMsg(
            e,
            imageMessages,
            `📣 本群外号呼叫记录（共 ${imageMessages.length} 页）`
        );
        await e.reply(forwardMsg);
        return true;
    }

    async whoAtme(e) {
        if (!e.isGroup) {
            await e.reply('此功能仅限群聊使用哦~', true);
            return true;
        }

        // --- 逻辑修复：精准判定查询目标 ---
        let targetQQ = String(e.user_id); // 默认查询发送指令的人
        
        // 只有当消息里明确不包含“我”，且确实艾特了某人时，才去查别人的
        // 我们用更稳妥的正则来匹配“我”字
        let isSearchSelf = /我/.test(e.msg);

        if (!isSearchSelf && e.at) {
            targetQQ = String(e.atBot ? Bot.uin : e.at);
        } else {
            // 如果是查自己，强制把 targetQQ 锁死为当前发送者
            targetQQ = String(e.user_id);
        }

        const filePath = path.join(atDataDir, `${e.group_id}.json`);
        if (!fs.existsSync(filePath)) {
            await e.reply('目前本群还没有真正的 @ 记录哦~\n如果要查看别人呼叫你外号的记录，请使用“谁叫我了”。', true);
            return true;
        }

        let groupData = {};
        try {
            groupData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        } catch (err) {
            return true;
        }

        // 获取全部历史数据
        let personal = groupData[targetQQ] || [];
        let everyone = groupData['all'] || [];
        let combinedData = [...personal, ...everyone];
        const imagesChanged = await cacheRecordImages(combinedData);
        if (imagesChanged) {
            fs.writeFileSync(filePath, JSON.stringify(groupData, null, 2), 'utf8');
        }

        if (combinedData.length === 0) {
            let name = (targetQQ === String(e.user_id)) ? '你' : 'TA';
            await e.reply(`目前没有人艾特过${name}哦~\n如果要查看外号呼叫记录，请使用“谁叫我了”。`, true);
            return true;
        }

        // 排序：从新到旧
        combinedData.sort((a, b) => b.timestamp - a.timestamp);
        const pageSize = 16;
        const totalPages = Math.ceil(combinedData.length / pageSize);
        const imageMessages = [];
        const renderId = `${e.group_id}_${targetQQ}_${Date.now()}`;

        // 渲染名字：如果是查自己就显示“我”，查别人就显示对方的名字
        let targetName = '我';
        if (targetQQ !== String(e.user_id)) {
            let member = e.group.pickMember(targetQQ);
            targetName = member?.card || member?.nickname || targetQQ;
        }

        for (let pageStart = 0; pageStart < combinedData.length; pageStart += pageSize) {
            const pageNumber = Math.floor(pageStart / pageSize) + 1;
            const pageRecords = combinedData.slice(pageStart, pageStart + pageSize);

            // --- 渲染 HTML (保持你修改后的背景和样式) ---
            let msgHtml = pageRecords.map(item => {
            const replyData = item.reply && typeof item.reply === 'object' ? item.reply : null;
            let replyHtml = '';
            if (replyData) {
                const replyUserId = escapeHtml(replyData.userId || '0');
                const replyName = escapeHtml(replyData.name || replyData.userId || '引用消息');
                const replyText = escapeHtml(replyData.text || '纯媒体消息').replace(/\n/g, '<br>');
                const replyImages = (Array.isArray(replyData.images) ? replyData.images : [])
                    .map(image => `<img class="reply-preview-image" src="${escapeHtml(image)}">`)
                    .join('');
                replyHtml = `<div class="reply-preview">
                    <div class="reply-preview-header">
                        <img class="reply-preview-avatar" src="https://q1.qlogo.cn/g?b=qq&nk=${replyUserId}&s=100">
                        <span>${replyName}</span>
                        <span class="reply-preview-label">引用消息</span>
                    </div>
                    <div class="reply-preview-text">${replyText}</div>${replyImages}
                </div>`;
            } else if (item.isReply) {
                replyHtml = `<div class="reply-box"><span class="icon">💬</span> 回复了你的消息</div>`;
            }
            const targetList = Array.isArray(item.targetQQs) ? item.targetQQs.map(String) : null;
            const atMe = !targetList || targetList.includes(String(targetQQ)) || item.isAtAll;
            let atHtml = atMe ? `<div class="media-hint">📣 艾特了你</div>` : '';
            let textHtml = escapeHtml(item.message || '').replace(/\n/g, '<br>') || `<div class="empty-at">纯艾特</div>`;
            let imgsHtml = (item.image || []).map(img => `<img class="msg-img" src="${escapeHtml(img)}">`).join('');
            let mediaHtml = `${item.hasVoice ? '<div class="media-hint">🎤 包含一段语音</div>' : ''}${item.hasVideo ? '<div class="media-hint">🎬 包含一段视频</div>' : ''}${item.hasCard ? '<div class="media-hint">🔗 包含分享卡片</div>' : ''}`;

            return `
            <div class="msg-item">
                <img class="avatar" src="https://q1.qlogo.cn/g?b=qq&nk=${item.User}&s=100">
                <div class="msg-content">
                    <div class="sender-info">
                        <span class="sender-name">${escapeHtml(item.name)}</span>
                        <span class="msg-time">${formatTime(item.timestamp)}</span>
                    </div>
                    <div class="bubble">${replyHtml}<div class="bubble-text">${textHtml}</div>${atHtml}${imgsHtml}${mediaHtml}</div>
                </div>
            </div>`;
        }).join('');

        // 这一段 htmlString 建议保留你已经在用的、带背景图的那个版本
        // 只需要确保里面的 ${targetQQ} 和 ${targetName} 变量正确即可
        let htmlString = `<!DOCTYPE html><html lang="zh"><head><meta charset="UTF-8"><style>:root { --theme-color: #7b8cf6; --bg-gradient: linear-gradient(135deg, #eef2fb 0%, #e0e7ff 100%); } body { font-family: 'PingFang SC', sans-serif; background: var(--bg-gradient); margin: 0; padding: 40px; width: 650px; } .container { background: rgba(255, 255, 255, 0.9); backdrop-filter: blur(10px); border-radius: 20px; padding: 30px; box-shadow: 0 10px 30px rgba(112, 128, 176, 0.15); border: 1px solid white; } .header { display: flex; align-items: center; padding-bottom: 25px; margin-bottom: 25px; border-bottom: 2px dashed #e5e7eb; } .header img { width: 68px; height: 68px; border-radius: 50%; margin-right: 18px; box-shadow: 0 4px 10px rgba(0,0,0,0.1); } .header-info h2 { margin: 0 0 6px 0; font-size: 24px; color: #1f2937; } .group-tag { font-size: 12px; background: var(--theme-color); color: white; padding: 3px 8px; border-radius: 6px; } .header-info p { margin: 0; font-size: 15px; color: #6b7280; } .header-info strong { color: var(--theme-color); } .msg-list { display: flex; flex-direction: column; gap: 28px; } .msg-item { display: flex; gap: 16px; } .avatar { width: 46px; height: 46px; border-radius: 12px; object-fit: cover; } .msg-content { flex: 1; max-width: calc(100% - 62px); } .sender-info { display: flex; align-items: center; gap: 10px; margin-bottom: 6px; } .sender-name { font-weight: 600; font-size: 15px; color: #374151; } .msg-time { font-size: 12px; color: #9ca3af; } .bubble { background: white; padding: 14px 18px; border-radius: 0 16px 16px 16px; font-size: 15px; box-shadow: 0 2px 8px rgba(0,0,0,0.04); border: 1px solid #f3f4f6; display: inline-block; max-width: 100%; } .reply-box { background: #f8fafc; border-left: 3px solid #94a3b8; padding: 6px 12px; border-radius: 4px 8px 8px 4px; font-size: 13px; color: #64748b; margin-bottom: 8px; display: flex; align-items: center; gap: 6px; } .reply-preview { background: #f8fafc; border-left: 3px solid #94a3b8; padding: 8px 10px; border-radius: 4px 8px 8px 4px; margin-bottom: 8px; color: #64748b; } .reply-preview-header { display: flex; align-items: center; gap: 6px; font-size: 12px; color: #475569; margin-bottom: 5px; } .reply-preview-avatar { width: 22px; height: 22px; border-radius: 50%; object-fit: cover; } .reply-preview-label { color: #94a3b8; font-size: 11px; } .reply-preview-text { font-size: 13px; line-height: 1.45; white-space: normal; word-break: break-word; } .reply-preview-image { max-width: 180px; max-height: 100px; border-radius: 6px; object-fit: cover; margin-top: 6px; display: block; } .empty-at { color: #9ca3af; font-style: italic; } .media-hint { color: var(--theme-color); font-size: 14px; margin-top: 8px; background: #f0f5ff; padding: 6px 12px; border-radius: 8px; } .msg-img { max-width: 100%; border-radius: 8px; margin-top: 10px; display: block; } .footer { margin-top: 35px; text-align: center; color: #cbd5e1; font-size: 12px; }</style></head><body><div class="container"><div class="header"><img src="https://q1.qlogo.cn/g?b=qq&nk=${targetQQ}&s=100"><div class="header-info"><h2>艾特数据报告 <span class="group-tag">${e.group_name || '本群'}</span></h2><p>历史记录中，<strong>${targetName}</strong> 共有 <strong>${combinedData.length}</strong> 条呼叫记录</p></div></div><div class="msg-list">${msgHtml}</div><div class="footer">Generated by 提醒助手 • ${new Date().toLocaleString()}</div></div></body></html>`;

            const htmlPath = path.join(
                atDataDir,
                `temp_render_${renderId}_${pageNumber}.html`
            );
            fs.writeFileSync(htmlPath, htmlString, 'utf8');
            try {
                const image = await puppeteer.screenshot(
                    `whoAtMe_${renderId}_${pageNumber}`,
                    { tplFile: htmlPath, data: {} }
                );
                if (image) imageMessages.push(image);
            } catch (err) {
                logger.error(`艾特记录第 ${pageNumber} 页渲染失败`, err);
            } finally {
                fs.rmSync(htmlPath, { force: true });
            }
        }

        if (imageMessages.length === 0) {
            await e.reply('艾特记录图片生成失败，请稍后再试~', true);
            return true;
        }

        if (imageMessages.length === 1) {
            await e.reply(imageMessages[0]);
            return true;
        }

        const forwardMsg = await common.makeForwardMsg(
            e,
            imageMessages,
            `📣 本群艾特记录（共 ${imageMessages.length} 页）`
        );
        await e.reply(forwardMsg);
        return true;
    }

    async aliasHelp(e) {
        await e.reply([
            '📛 外号提醒插件帮助',
            '',
            '【普通用户】',
            '#外号设置 外号 —— 给自己设置外号，可重复设置多个',
            '#查看外号 —— 查看自己设置的全部外号和提醒状态',
            '#查看外号 @用户 —— 查看指定用户设置的全部外号和提醒状态',
            '#外号删除 外号 —— 删除自己设置的外号',
            '#外号提醒开启/关闭 或 #设置外号提醒开启/关闭 —— 开关自己的外号提及提醒',
            '#艾特提醒开启/关闭 或 #设置艾特提醒开启/关闭 —— 开关别人艾特或引用自己的提醒',
            '#自艾特提醒开启/关闭 或 #设置自艾特提醒开启/关闭 —— 开关自己艾特或引用自己的提醒',
            '',
            '【外号提醒】',
            '外号和艾特提醒默认关闭；关闭时仍会保存记录，但不会主动群内艾特或私聊提醒。',
            '提醒能否私聊成功取决于好友关系和平台权限。',
            '',
            '【主人专用】',
            '#外号设置/alias @用户 外号 —— 主人或群管理员给指定用户设置外号',
            '#设置外号提醒 @用户 开启/关闭 —— 主人设置指定用户的外号提醒',
            '#设置艾特提醒 @用户 开启/关闭 —— 主人设置指定用户的艾特提醒',
            '#设置自艾特提醒 @用户 开启/关闭 —— 主人设置指定用户的自艾特提醒',
            '#查看全部外号 —— 查看所有用户的外号和提醒状态，内容过多时分包合并发送',
            '#清除全部艾特数据 —— 清空所有群的艾特记录',
            '',
            '【记录查询】',
            '谁艾特我 —— 查看历史艾特记录（每张图片最多显示16条）',
            '谁艾特他/她/它 —— 艾特目标用户后查看对方的艾特记录',
            '谁叫我了 —— 查看当前群里呼叫过你外号的历史记录',
            '谁叫他/她/它了 @用户 —— 查看指定用户被呼叫外号的历史记录',
            '/clear_at —— 清除自己的艾特记录',
            '/clear_all —— 主人清除全部艾特记录'
        ].join('\n'));
        return true;
    }

    async setNotifyPreference(e) {
        const commandText = cleanAlias(e.msg || '');
        const match = commandText.match(/^#?(设置)?(外号提醒|艾特提醒|自艾特提醒)(?:\s+.*)?(开启|关闭|开|关)$/i);
        if (!match) return false;

        if (e.atBot) {
            await e.reply('不能给机器人设置提醒开关哦~', true);
            return true;
        }

        const hasTargetUser = Boolean(e.at && !e.atBot);
        if (hasTargetUser && !e.isMaster) {
            await e.reply('暂无权限，只有主人才能设置其他用户的提醒开关', true);
            return true;
        }

        const type = match[2];
        const enabled = /^(开启|开)$/i.test(match[3]);
        const targetUserId = hasTargetUser ? String(e.at) : String(e.user_id);
        if (!/^\d+$/.test(targetUserId) || targetUserId === String(Bot.uin)) {
            await e.reply('目标用户 QQ 号无效，不能设置机器人本身~', true);
            return true;
        }

        try {
            updateNotifySetting(targetUserId, type, enabled);
            const subject = hasTargetUser ? `${targetUserId} 的` : '你的';
            await e.reply(`✅ 已将${subject}${type}${enabled ? '开启' : '关闭'}。`, true);
        } catch (err) {
            logger.error(`提醒配置保存失败：${targetUserId}`, err);
            await e.reply('提醒配置保存失败，请稍后再试~', true);
        }
        return true;
    }

    async setAliasForUser(e) {
        const commandText = cleanAlias(e.msg || '');
        const alias = cleanAlias(commandText.replace(/^#?(?:外号设置|设置外号|alias)(?:\/(?:alias|外号))?/i, ''));
        const hasTargetUser = Boolean(e.at && !e.atBot);
        let targetUserId = String(e.user_id);

        if (!alias) {
            await e.reply([
                '给自己设置：#外号设置 外号',
                '给主人代设置：#外号设置/alias @用户 外号'
            ].join('\n'), true);
            return true;
        }

        if (e.atBot) {
            await e.reply('不能给机器人自己设置外号哦~', true);
            return true;
        }

        if (hasTargetUser) {
            if (!canManageOtherUser(e)) {
                await e.reply('暂无权限，只有主人或群管理员才能给其他用户设置外号', true);
                return true;
            }
            targetUserId = String(e.at);
        }

        if (!/^\d+$/.test(targetUserId)) {
            await e.reply('目标用户 QQ 号无效，请重新尝试~', true);
            return true;
        }

        if (targetUserId === String(Bot.uin)) {
            await e.reply('不能给机器人自己设置外号哦~', true);
            return true;
        }

        const result = saveAliasForUser(targetUserId, alias);
        await e.reply(result.message, true);
        return true;
    }

    async removeAlias(e) {
        const match = String(e.msg || '').match(/^#?外号删除\s*(.+)$/);
        const alias = cleanAlias(match?.[1]);
        if (!alias) {
            await e.reply('请在命令后面填写要删除的外号哦~', true);
            return true;
        }

        const userId = String(e.user_id);
        const aliases = readAliasFile(userId);
        const aliasKeyValue = aliasKey(alias);
        const remainingAliases = aliases.filter(item => aliasKey(item) !== aliasKeyValue);
        if (remainingAliases.length === aliases.length) {
            await e.reply(`你没有设置过外号“${alias}”哦~`, true);
            return true;
        }

        try {
            if (remainingAliases.length > 0) writeAliasFile(userId, remainingAliases);
            else deleteAliasFile(userId);
            await e.reply(`✅ 外号“${alias}”已删除！`, true);
        } catch (err) {
            logger.error(`外号删除失败：${userId}`, err);
            await e.reply('外号删除失败，请稍后再试~', true);
        }
        return true;
    }

    async viewAliases(e) {
        const commandText = cleanAlias(e.msg || '');
        const commandArgument = cleanAlias(
            commandText.replace(/^#?(查看外号|我的外号)\s*/i, '')
        );
        let targetUserId = String(e.user_id);

        if (e.at && !e.atBot) {
            targetUserId = String(e.at);
        } else if (/^\d+$/.test(commandArgument)) {
            targetUserId = commandArgument;
        } else if (commandArgument) {
            await e.reply('用法：#查看外号，或：#查看外号 @用户', true);
            return true;
        }

        const aliases = readAliasFile(targetUserId);
        const settings = getNotifySettings(targetUserId);
        const isSelf = targetUserId === String(e.user_id);
        let targetName = isSelf ? '你' : targetUserId;
        if (!isSelf && e.group?.pickMember) {
            const member = e.group.pickMember(targetUserId);
            targetName = member?.card || member?.nickname || targetUserId;
        }

        const lines = [
            `📛 ${isSelf ? '你' : targetName}的外号`,
            ...(aliases.length > 0
                ? aliases.map((alias, index) => `${index + 1}. ${alias}`)
                : ['暂无外号']),
            '',
            '🔔 提醒设置',
            ...formatNotifyStatus(settings)
        ];
        if (aliases.length === 0 && isSelf) {
            lines.splice(1, 0, '可以使用：#外号设置 外号');
        }
        await e.reply(lines.join('\n'));
        return true;
    }

    async allAliases(e) {
        const entries = readAllAliasFiles();
        if (entries.length === 0) {
            await e.reply('目前还没有任何用户设置外号哦~', true);
            return true;
        }

        const messages = entries.map(entry => {
            const settings = getNotifySettings(entry.userId);
            return [
                `QQ：${entry.userId}`,
                `外号：${entry.aliases.join('、')}`,
                ...formatNotifyStatus(settings)
            ].join('\n');
        });
        const chunks = splitForwardMessages(messages);
        for (let index = 0; index < chunks.length; index++) {
            const title = chunks.length === 1
                ? `📛 全部外号（共 ${entries.length} 位用户）`
                : `📛 全部外号（第 ${index + 1}/${chunks.length} 组，共 ${entries.length} 位用户）`;
            const forwardMsg = await common.makeForwardMsg(e, chunks[index], title);
            await e.reply(forwardMsg);
        }
        return true;
    }

    async aliasNotice(e) {
        if (!e.isGroup || !e.msg || isAliasCommand(e.msg)) return false;

        const messageText = cleanAlias(e.msg);
        if (!messageText) return false;

        const matchedUsers = [];
        for (const entry of readAllAliasFiles()) {
            const matchedAliases = entry.aliases.filter(alias => messageText.includes(alias));
            if (matchedAliases.length > 0) {
                matchedUsers.push({
                    userId: entry.userId,
                    aliases: matchedAliases
                });
            }
        }
        if (matchedUsers.length === 0) return false;

        const callerName = e.sender?.card || e.sender?.nickname || e.nickname || String(e.user_id);
        const callRecord = {
            caller_id: String(e.user_id),
            caller_name: callerName,
            message: e.msg || '纯外号呼叫',
            group: e.group_name || String(e.group_id),
            group_id: String(e.group_id),
            timestamp: Date.now()
        };
        for (const user of matchedUsers) {
            try {
                appendCalledRecord(user.userId, {
                    ...callRecord,
                    aliases: user.aliases
                });
            } catch (err) {
                logger.error(`外号呼叫记录保存失败：${user.userId}`, err);
            }
        }

        const enabledUsers = matchedUsers.filter(user =>
            getNotifySettings(user.userId).alias_notify
        );
        const standaloneUsers = enabledUsers.filter(user =>
            user.aliases.some(alias => messageText === cleanAlias(alias))
        );
        if (standaloneUsers.length > 0) {
            const groupMessage = ['📣 有人提到了外号：'];
            for (const user of standaloneUsers) {
                groupMessage.push(
                    segment.at(Number(user.userId)),
                    `（${user.aliases.join('、')}）`
                );
            }
            groupMessage.push('\n我已经根据用户设置尝试私聊提醒。');
            try {
                await e.reply(groupMessage);
            } catch (err) {
                logger.error('外号群内艾特发送失败', err);
            }
        }

        const source = e.group_name ? `${e.group_name}(${e.group_id})` : String(e.group_id);
        await Promise.allSettled(enabledUsers.map(async user => {
            if (String(user.userId) === String(Bot.uin)) return;

            const privateMessage = [
                `有人在群「${source}」里提到了你的外号：${user.aliases.join('、')}\n`,
                `提及人：${getActorDisplay(e)}\n`,
                `时间：${formatDateTime(callRecord.timestamp)}\n`,
                `消息：${e.msg}`
            ];
            try {
                await Bot.pickUser(Number(user.userId)).sendMsg(privateMessage);
            } catch (err) {
                logger.warn(`外号私聊提醒发送失败：${user.userId}`, err);
            }
        }));

        return true;
    }

    async clearAt(e) {
        if (!e.isGroup) {
            await e.reply('只支持群聊使用哦~');
            return false;
        }
        const filePath = path.join(atDataDir, `${e.group_id}.json`);
        if (!fs.existsSync(filePath)) {
            await e.reply('目前没有你的at数据，无需清除~', true);
            return false;
        }

        let groupData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (!groupData[e.user_id]) {
            await e.reply('目前没有你的at数据，无需清除~', true);
            return false;
        }

        delete groupData[e.user_id];
        fs.writeFileSync(filePath, JSON.stringify(groupData, null, 2), 'utf8');
        await e.reply('✅ 已成功清除你的艾特数据！', true);
    }

    async clearAll(e) {
        if (fs.existsSync(atDataDir)) {
            fs.rmSync(atDataDir, { recursive: true, force: true });
            fs.mkdirSync(atDataDir, { recursive: true });
        }
        await e.reply('✅ 已成功清除所有群的全部艾特数据！');
    }
}
