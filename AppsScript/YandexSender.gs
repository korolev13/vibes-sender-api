/**
 * VIBES Sender API V1 client for Google Apps Script.
 *
 * IMPORTANT:
 * - This file sends HTTPS requests to your Railway service.
 * - GmailApp/MailApp do NOT send the email here.
 * - The old mail_template.html remains unchanged and is rendered by Apps Script.
 * - reference.png is embedded by the Railway service as cid:reference.
 *
 * Script Properties required:
 *   VIBES_SENDER_API_URL = https://YOUR-SERVICE.up.railway.app
 *   VIBES_SENDER_API_KEY = your long API secret
 */

function vibesSenderApiSettings_() {
  const props = PropertiesService.getScriptProperties();
  const url = String(props.getProperty('VIBES_SENDER_API_URL') || '').replace(/\/+$/, '');
  const key = String(props.getProperty('VIBES_SENDER_API_KEY') || '').trim();

  if (!url) throw new Error('Не задан Script Property VIBES_SENDER_API_URL');
  if (!key) throw new Error('Не задан Script Property VIBES_SENDER_API_KEY');

  return { url: url, key: key };
}

function vibesSenderApiParse_(response) {
  const status = response.getResponseCode();
  const raw = response.getContentText() || '';
  let data;
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch (err) {
    data = { ok: false, error: 'invalid_json', raw: raw.slice(0, 1000) };
  }

  if (status < 200 || status >= 300 || data.ok === false) {
    throw new Error(
      'VIBES Sender API HTTP ' + status + ': ' +
      (data.message || data.error || raw || 'unknown error')
    );
  }

  return data;
}

function vibesSenderApiRequest_(path, method, payload, authRequired) {
  const cfg = vibesSenderApiSettings_();
  const options = {
    method: method || 'get',
    muteHttpExceptions: true,
    headers: {}
  };

  if (authRequired !== false) {
    options.headers.Authorization = 'Bearer ' + cfg.key;
  }

  if (payload != null) {
    options.contentType = 'application/json';
    options.payload = JSON.stringify(payload);
  }

  return vibesSenderApiParse_(UrlFetchApp.fetch(cfg.url + path, options));
}

function diagnosticsVibesSenderApi() {
  const health = vibesSenderApiRequest_('/health', 'get', null, false);
  const smtp = vibesSenderApiRequest_('/smtp-health', 'get', null, true);

  const result = {
    apiOk: !!health.ok,
    service: health.service || '',
    version: health.version || '',
    directSmtp: health.transport === 'direct SMTP',
    referenceReady: !!health.referenceReady,
    smtpOk: !!smtp.ok,
    smtp: smtp.smtp || '',
    smtpPort: smtp.port || null,
    smtpUser: smtp.user || '',
    gmailUsedForSending: false
  };

  Logger.log(JSON.stringify(result, null, 2));
  return result;
}

function vibesApiOutboundEmail_() {
  if (typeof VIBES_CONFIG !== 'undefined' && VIBES_CONFIG.outboundSenderEmail) {
    return String(VIBES_CONFIG.outboundSenderEmail).trim();
  }
  return 'art@vibesvideolab.space';
}

function vibesApiWebsite_(key, fallback) {
  if (typeof VIBES_CONFIG !== 'undefined' && VIBES_CONFIG[key]) {
    return String(VIBES_CONFIG[key]).trim();
  }
  return fallback;
}

function vibesRenderCfgViaApi_(cfg, isAgency) {
  const template = HtmlService.createTemplateFromFile('mail_template');
  template.cfg = cfg;
  template.isAgency = !!isAgency;
  return template.evaluate().getContent();
}

function vibesSendHtmlViaApi_(rendered, requestId) {
  if (!rendered || !rendered.to || !rendered.subject || !rendered.html) {
    throw new Error('vibesSendHtmlViaApi_: to / subject / html обязательны');
  }

  const payload = {
    to: String(rendered.to).trim(),
    subject: String(rendered.subject).trim(),
    html: String(rendered.html),
    text: String(rendered.text || 'VIBES Video Lab'),
    requestId: String(requestId || '').trim()
  };

  const result = vibesSenderApiRequest_('/send', 'post', payload, true);
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}

/**
 * Real test of the OLD V6.1 HTML through Railway -> Yandex SMTP.
 * Sends exactly one email to art@vibesvideolab.space.
 */
function testVibesSenderApiToSelf() {
  const recipient = vibesApiOutboundEmail_();
  const cfg = {
    recipient: recipient,
    name: 'Никита',
    company: 'VIBES API TEST',
    type: 'brand',
    intro: 'Это тест VIBES Sender API. Старый HTML рендерится в Apps Script, а само письмо отправляется напрямую через Railway и SMTP Яндекс 360 — без GmailApp.',
    zoomCta: 'Если письмо выглядит как старый V6.1 и From = art@vibesvideolab.space, новый транспорт работает правильно.',
    websiteUrl: vibesApiWebsite_('websiteUrl', 'https://vibeslab.space/'),
    portfolioUrl: vibesApiWebsite_('portfolioUrl', 'https://vibeslab.space/#work'),
    proposalUrl: vibesApiWebsite_('proposalUrl', 'https://vibeslab.space/#contact'),
    telegramUrl: vibesApiWebsite_('telegramUrl', 'https://t.me/media_nick')
  };

  const html = vibesRenderCfgViaApi_(cfg, false);
  return vibesSendHtmlViaApi_({
    to: recipient,
    subject: 'TEST · VIBES Sender API · direct Yandex SMTP',
    html: html,
    text: 'VIBES Sender API test. Direct Yandex SMTP transport.'
  }, 'self-test-' + new Date().getTime());
}

/**
 * Optional compatibility layer for the current V8.1 Code.gs.
 * It lets existing calls route the actual SEND through the API.
 * NOTE: current V8.1 Code.gs still creates Gmail drafts and still checks Google quota.
 * We will remove those two dependencies in the next V9 Multi-Sender patch.
 */
function vibesOutboundEmail_() {
  return vibesApiOutboundEmail_();
}

function vibesOutboundName_() {
  if (typeof VIBES_CONFIG !== 'undefined' && VIBES_CONFIG.outboundSenderName) {
    return String(VIBES_CONFIG.outboundSenderName).trim();
  }
  return 'VIBES Video Lab';
}

function vibesAssertAliasReady_() {
  // Alias is no longer required for the API transport.
  // Validate the remote sender instead.
  return diagnosticsVibesSenderApi();
}

function vibesRenderRowForAlias_(row) {
  if (typeof COL === 'undefined') throw new Error('COL не найден: нужен текущий Code.gs');
  const c = function(v) { return String(v == null ? '' : v).trim(); };
  const company = c(row[COL.company - 1]);
  const type = c(row[COL.type - 1]).toLowerCase() || 'brand';
  const email = c(row[COL.email - 1]);
  const name = c(row[COL.name - 1]) || 'Коллеги';
  const subject = c(row[COL.subject - 1]) || ('Идея для ' + company + ' — VIBES');
  const intro = c(row[COL.intro - 1]);
  const zoomCta = c(row[COL.zoomCta - 1]) ||
    'Если актуально, можем созвониться на 15 минут — покажу релевантные кейсы и обсудим задачу.';

  if (!company) throw new Error('Пустая Company');
  if (!email || email.indexOf('@') < 1) throw new Error('Некорректный Email');
  if (!intro) throw new Error('Пустой Intro');

  const cfg = {
    recipient: email,
    name: name,
    company: company,
    type: type,
    intro: intro,
    zoomCta: zoomCta,
    websiteUrl: vibesApiWebsite_('websiteUrl', 'https://vibeslab.space/'),
    portfolioUrl: vibesApiWebsite_('portfolioUrl', 'https://vibeslab.space/#work'),
    proposalUrl: vibesApiWebsite_('proposalUrl', 'https://vibeslab.space/#contact'),
    telegramUrl: vibesApiWebsite_('telegramUrl', 'https://t.me/media_nick')
  };

  const html = vibesRenderCfgViaApi_(cfg, type === 'agency');
  const text =
    'Здравствуйте, ' + name + '.\n\n' +
    intro + '\n\n' +
    zoomCta + '\n\n' +
    'Портфолио: ' + cfg.portfolioUrl + '\n' +
    'Контакт: ' + cfg.telegramUrl;

  return { to: email, subject: subject, html: html, text: text };
}

function vibesSendHtmlViaAlias_(rendered) {
  const requestId = 'legacy-v81-' + Utilities.getUuid();
  return vibesSendHtmlViaApi_(rendered, requestId);
}
