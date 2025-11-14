import plugin from '../../lib/plugins/plugin.js';
import puppeteer from '../../lib/puppeteer/puppeteer.js';
import { segment } from 'oicq';
import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';

let isRunning = false;

export class oneLastImage extends plugin {
  constructor() {
    super({
      name: '卢浮宫生成器',
      dsc: '生成One Last Kiss风格的图片',
      event: 'message',
      priority: 500,
      rule: [
        {
          reg: /^#卢浮宫(帮助|help)$/i,
          fnc: 'showHelp'
        },
        {
          reg: '^#卢浮宫',
          fnc: 'generateLouvreImage'
        }
      ]
    });
  }
  
  /**
   * 显示插件帮助信息
   */
  async showHelp(e) {
    const helpMsg = `======= 卢浮宫生成器 =======
可通过添加不同参数，自由组合生成效果。

【基础用法】
 ▸ #卢浮宫 + [图片]
 ▸ [回复图片] + #卢浮宫
 ▸ #卢浮宫 @某人

【可用参数】 (可任意组合)
 ▸ 线条风格 (默认: 一般)
   精细, 稍粗, 超粗, 极粗, 浮雕, 线稿
   
 ▸ 开关选项 (兼容大小写, 如"关kiss")
   开/关降噪 (默认: 开)
   开/关Kiss (默认: 开)
   开/关水印 (默认: 开)
   开/关初回 (默认: 关)
   
 ▸ 数值滑块
   线迹[数值] (范围80-126, 默认: 118)
   调子[数值] (范围20-200, 默认: 108)

【使用示例】
 ▸ #卢浮宫 关水印
 ▸ #卢浮宫 超粗 线迹90
 ▸ #卢浮宫 开初回 关降噪 调子190
    `;
    await e.reply(helpMsg);
    return true;
  }

  /**
   * 主函数，处理图片生成请求
   */
  async generateLouvreImage(e) {
    if (isRunning) {
      e.reply('当前有任务正在生成，请稍后再试');
      return true;
    }
    isRunning = true;

    try {
      let imageUrl = '';

      if (e.source) {
        const reply = await e.getReply();
        if (reply?.message) {
          for (const msg of reply.message) {
            if (msg.type === 'image') {
              imageUrl = msg.url;
              break;
            }
          }
        }
      }

      if (!imageUrl && e.img?.length > 0) {
        imageUrl = e.img[0].url || e.img[0];
      }

      if (!imageUrl && e.at) {
        imageUrl = `https://q1.qlogo.cn/g?b=qq&nk=${e.at}&s=640`;
      }

      if (!imageUrl) {
        e.reply('请发送 #卢浮宫+[图片]，或引用图片回复#卢浮宫，或 #卢浮宫@某人');
        isRunning = false;
        return true;
      }

      const options = this.parseOptions(e.msg);
      logger.info(`[卢浮宫生成器] 应用参数: ${JSON.stringify(options)}`);

      const waitingMsg = await e.reply('图片收到，正在送往卢浮宫加工...', true);
      const base64Image = await this.render(imageUrl, options);
      
      if (waitingMsg?.message_id && e.bot.recallMsg) {
         try {
           await e.bot.recallMsg(e.group_id || e.user_id, waitingMsg.message_id);
         } catch (err) { /* 忽略撤回失败 */ }
      }

      if (base64Image) {
        await e.reply(segment.image(base64Image));
      } else {
        await e.reply('生成失败了，可能是网站的防护机制导致无法处理，请稍后再试 T_T');
      }

    } catch (error) {
      logger.error('[卢浮宫生成器] 插件执行出错:', error);
      await e.reply('插件出错了，请联系机器人管理员查看后台日志');
    } finally {
      isRunning = false;
    }
    return true;
  }

  /**
   * 解析用户输入的参数, 未指定的参数将保持默认值
   */
  parseOptions(msg) {
    const options = {
      style: '一般',
      lineWeight: 118,
      toneCount: 108,
      denoise: true,
      kiss: true,
      watermark: true,
      firstEdition: false,
    };
    if (!msg) return options;
    const cleanMsg = msg.replace(/^#卢浮宫/, '').trim();
    const lowerCaseMsg = cleanMsg.toLowerCase();

    const styles = ['精细', '稍粗', '超粗', '极粗', '浮雕', '线稿'];
    for (const style of styles) {
      if (cleanMsg.includes(style)) {
        options.style = style;
        break;
      }
    }

    const lineMatch = cleanMsg.match(/线迹\s*(\d+)/);
    if (lineMatch?.[1]) {
      options.lineWeight = Math.max(80, Math.min(126, parseInt(lineMatch[1])));
    }

    const toneMatch = cleanMsg.match(/调子\s*(\d+)/);
    if (toneMatch?.[1]) {
      options.toneCount = Math.max(20, Math.min(200, parseInt(toneMatch[1])));
    }
    
    const toggles = [
      { key: 'denoise', name: '降噪' },
      { key: 'kiss', name: 'Kiss' },
      { key: 'watermark', name: '水印' },
      { key: 'firstEdition', name: '初回' }
    ];
    for (const toggle of toggles) {
      const lowerCaseName = toggle.name.toLowerCase();
      if (lowerCaseMsg.includes('开' + lowerCaseName)) {
        options[toggle.key] = true;
      } else if (lowerCaseMsg.includes('关' + lowerCaseName)) {
        options[toggle.key] = false;
      }
    }

    return options;
  }

  /**
   * 使用 Puppeteer 进行网页渲染
   */
  async render(imageUrl, options) {
    const browser = await puppeteer.browserInit().catch(err => logger.error(`[卢浮宫生成器] Puppeteer 初始化失败: ${err}`) || null);
    if (!browser) return null;

    const page = await browser.newPage();
    let base64Data = null;

    const pluginDir = path.resolve(process.cwd(), 'plugins', 'example');
    const tempDir = path.join(pluginDir, 'temp');
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
    const tempFilePath = path.join(tempDir, `one-last-image-${Date.now()}.png`);

    try {
      const response = await fetch(imageUrl);
      if (!response.ok) throw new Error(`下载图片失败: ${response.statusText}`);
      const buffer = Buffer.from(await response.arrayBuffer());
      fs.writeFileSync(tempFilePath, buffer);

      await page.goto('https://lab.magiconch.com/one-last-image/', { waitUntil: 'networkidle0', timeout: 60000 });
      await page.setViewport({ width: 1280, height: 800 });
      
      const buttonSelector = 'button.btn.current';
      await page.waitForSelector(buttonSelector, { visible: true, timeout: 15000 });
      await new Promise(resolve => setTimeout(resolve, 200));

      const [fileChooser] = await Promise.all([
        page.waitForFileChooser({ timeout: 15000 }),
        page.evaluate(selector => document.querySelector(selector).click(), buttonSelector)
      ]);
      await fileChooser.accept([tempFilePath]);

      await page.waitForSelector('.loading-box[style*="display: none"]', { timeout: 45000 });
      
      if (options.style !== '一般') {
        const styleTab = await page.$(`a[data-text="${options.style}"]`);
        if (styleTab) await styleTab.click();
      }

      const setSliderValue = async (sliderIndex, value) => {
        const slider = await page.waitForXPath(`(//input[@type="range"])[${sliderIndex}]`);
        if (slider) {
          await page.evaluate((el, val) => {
            el.value = val;
            el.dispatchEvent(new Event('input', { bubbles: true }));
          }, slider, value);
        }
      };
      await setSliderValue(1, options.lineWeight);
      await setSliderValue(2, options.toneCount);
      
      const toggleSwitch = async (name, desiredState) => {
        const spanXPath = `//span[@class='ui-switch-box' and ./span[text()='${name}']]`;
        const spanHandle = await page.waitForXPath(spanXPath, { timeout: 5000 }).catch(() => null);
        if (!spanHandle) return logger.warn(`[卢浮宫生成器] 未找到开关: ${name}`);

        const currentState = await page.evaluate(el => el.getAttribute('data-checked') === 'true', spanHandle);
        if (currentState !== desiredState) {
          const switchButton = await spanHandle.$('a.switch');
          if (switchButton) {
            await switchButton.click();
            logger.info(`[卢浮宫生成器] 切换开关 '${name}' 为: ${desiredState ? '开' : '关'}`);
          }
        }
      };
      await toggleSwitch('降噪', options.denoise);
      await toggleSwitch('Kiss', options.kiss);
      await toggleSwitch('水印', options.watermark);
      await toggleSwitch('初回', options.firstEdition);

      await new Promise(resolve => setTimeout(resolve, 500));
      base64Data = await page.$eval('canvas', (canvas) => canvas.toDataURL('image/jpeg', 0.9));

    } catch (error) {
      logger.error('[卢浮宫生成器] Puppeteer 渲染失败:', error);
      base64Data = null;
    } finally {
      if (page) await page.close();
      if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
    }
    return base64Data;
  }
}
