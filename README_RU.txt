VIBES SENDER API V1
===================

Цель
----
Убрать GmailApp/MailApp из транспорта отправки.

Новая цепочка:
Google Sheet -> Apps Script -> HTTPS -> Railway -> smtp.yandex.ru:465 -> получатель

Старый mail_template.html НЕ изменён.
Большой visual reference.png отправляется сервером как cid:reference.

ВАЖНО ПЕРЕД НАСТРОЙКОЙ
----------------------
Если V8.1 сейчас автоматически рассылает письма, сначала в Apps Script выполни:

  emergencyStopAutoSend()

чтобы во время переноса не ушли письма старым транспортом.


1. ЧТО ЗАЛИВАТЬ В GITHUB
------------------------
Создай отдельный репозиторий, например:

  vibes-sender-api

В корень репозитория загрузи:

  server.js
  package.json
  reference.png
  .gitignore
  .env.example

mail_template.html можно тоже оставить в репозитории как резервную копию, но Node.js его не рендерит.
HTML продолжает рендерить Apps Script, поэтому оригинальный Google Apps Script template остаётся без изменений.

НИКОГДА не загружай настоящий .env и пароль приложения Яндекс в GitHub.


2. RAILWAY
----------
На экране New Project нажми:

  GitHub Repository

и выбери созданный репозиторий vibes-sender-api.
Railway увидит package.json и запустит npm start автоматически.

После создания Service открой Variables и добавь:

SMTP_HOST=smtp.yandex.ru
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=art@vibesvideolab.space
SMTP_PASSWORD=<ПАРОЛЬ ПРИЛОЖЕНИЯ ЯНДЕКС>
FROM_NAME=VIBES Video Lab
REPLY_TO=art@vibesvideolab.space
MESSAGE_ID_DOMAIN=vibesvideolab.space
API_KEY=<ДЛИННЫЙ СЛУЧАЙНЫЙ СЕКРЕТ>
MAX_REQUESTS_PER_MINUTE=120

API_KEY и SMTP_PASSWORD сюда в ChatGPT не присылай.

Для API_KEY можно локально получить 64 hex-символа:

  openssl rand -hex 32

или создать любой длинный случайный секрет в менеджере паролей.


3. ПОЛУЧИТЬ ПУБЛИЧНЫЙ DOMAIN
----------------------------
В Railway у Service открой Settings / Networking и нажми Generate Domain.
Получишь адрес вида:

  https://vibes-sender-api-production.up.railway.app

Проверь в браузере:

  https://ТВОЙ-ДОМЕН/health

Нормальный ответ:

  {"ok":true,"service":"VIBES Sender API","version":"1.0.0",...}

/health не проверяет пароль SMTP специально: Railway может дёргать health endpoint часто.
SMTP проверяется отдельным защищённым /smtp-health.


4. APPS SCRIPT PROPERTIES
-------------------------
Apps Script -> Project Settings -> Script properties:

VIBES_SENDER_API_URL = https://ТВОЙ-RAILWAY-ДОМЕН
VIBES_SENDER_API_KEY = тот же API_KEY из Railway


5. APPS SCRIPT FILE
-------------------
Из папки AppsScript возьми:

  YandexSender.gs

Для первого теста лучше НЕ запускать авторассылку.
Файл содержит:

  diagnosticsVibesSenderApi()
  testVibesSenderApiToSelf()

Первым запусти:

  diagnosticsVibesSenderApi()

Он проверит одновременно:
- Railway API
- reference.png
- реальный логин в smtp.yandex.ru

Ожидаем:

  apiOk: true
  directSmtp: true
  smtpOk: true
  smtpUser: art@vibesvideolab.space
  gmailUsedForSending: false

После этого запусти:

  testVibesSenderApiToSelf()

Это отправит ОДНО настоящее письмо на art@vibesvideolab.space:
- со старым V6.1 HTML
- с reference.png
- From: art@vibesvideolab.space
- напрямую через Yandex SMTP
- GmailApp/MailApp не участвуют в отправке


6. API ENDPOINTS
----------------
GET  /health
  Публичный lightweight healthcheck. Секреты не показывает.

GET  /smtp-health
  Требует Authorization: Bearer <API_KEY>.
  Делает настоящий transporter.verify() до smtp.yandex.ru.

POST /send
  Требует Authorization: Bearer <API_KEY>.
  JSON:
  {
    "to": "client@example.com",
    "subject": "Brand × VIBES",
    "html": "<html>...</html>",
    "text": "fallback",
    "requestId": "lead-123-first"
  }

POST /test
  Требует Authorization: Bearer <API_KEY>.
  Отправляет простой SMTP test. По умолчанию на SMTP_USER.


7. ЧТО V1 УЖЕ ДЕЛАЕТ
--------------------
- direct Yandex SMTP 465
- Bearer API key
- старый HTML приходит от Apps Script как уже отрендеренный HTML
- reference.png сервер добавляет как cid:reference
- собственный RFC Message-ID
- SMTP accepted/rejected/response возвращаются Apps Script
- requestId + best-effort idempotency внутри текущего процесса
- rate guard
- нет Gmail recipient quota в самом /send


8. ЧТО ДЕЛАЕМ ПОСЛЕ УСПЕШНОГО TEST
-----------------------------------
После подтверждения одного письма собираем V9 Multi-Sender:

- полностью убираем Gmail drafts из боевого контура
- полностью убираем MailApp.getRemainingDailyQuota()
- Google Sheet остаётся CRM/queue
- создаём лист Senders
- sender pool из нескольких Яндекс 360 mailbox
- дневные лимиты на mailbox
- round-robin / least-loaded routing
- persistent idempotency
- FU1 / FU2
- reply + bounce processor
- Telegram notifications

Не запускай старый approveAndStartAutoSend() до V9, если хочешь полностью исключить Gmail из боевого транспорта.
