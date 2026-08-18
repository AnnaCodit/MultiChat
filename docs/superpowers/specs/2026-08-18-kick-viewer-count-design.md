# Спецификация: Отображение количества зрителей Kick в statusKick

## 1. Цель
Отображать текущее количество онлайн-зрителей для подключенного канала Kick непосредственно в элементе `#statusKick` с темно-красным оформлением.

## 2. Конфигурация и получение данных (`js/connectors/kick.js`)
- Объявляется объект конфигурации:
  ```js
  const KICK_CONNECTOR_CONFIG = Object.freeze({
    viewerPollIntervalMs: 20000
  });
  ```
- Метод `fetchViewerCount()`:
  - Выполняет запрос к `https://kick.com/api/v2/channels/${encodeURIComponent(this.channel)}` через `fetchWithCorsProxy`.
  - Из ответа извлекает `data?.livestream?.viewer_count`.
  - Если `livestream` активен, возвращает число `viewer_count`. Если `livestream` равен `null` или отсутствует — возвращает `null`.
  - При ошибке сети тихо повторяет попытку через 20 секунд.
- Опрос запускается при успешном подключении WS (`initPusherWS`) и повторяется каждые 20 секунд.
- При вызове `disconnect()` / `cleanup()` таймер и активный контроллер запроса очищаются.
- Коннектор передает количество зрителей в callback `onStatus(platform, isConnected, description, viewerCount)`.

## 3. Обновление интерфейса (`index.html`, `js/app.js`)
- В [`index.html`](file:///C:/FRA3A/projects/MultiChat/index.html) элемент `#statusKick` дополняется контейнером для числа зрителей:
  ```html
  <span class="status-badge status-kick offline" id="statusKick" title="Kick">
    <span class="platform-icon kick-icon"></span> KI <span id="kickViewerCount" class="viewer-count"></span>
  </span>
  ```
- В `MultiChatApp.prototype.updateStatus` ([`js/app.js`](file:///C:/FRA3A/projects/MultiChat/js/app.js)):
  - При обновлении Kick, если передано число зрителей `viewerCount !== null && viewerCount !== undefined`:
    - В `#kickViewerCount` записывается число зрителей.
  - Если `viewerCount === null` или статус оффлайн:
    - Текст в `#kickViewerCount` очищается.

## 4. Стилизация (`style.css`)
- Для `.status-kick.online` задается темно-красный цвет/стиль:
  ```css
  .status-kick.online {
    background-color: rgba(139, 0, 0, 0.4);
    border-color: rgba(220, 38, 38, 0.4);
    color: #ffcccc;
  }
  ```

## 5. Тестирование
- Добавить тесты на `KickConnector`:
  - Опрос `viewer_count` из `data.livestream.viewer_count`.
  - Корректная обработка `data.livestream = null`.
  - Использование интервала `KICK_CONNECTOR_CONFIG.viewerPollIntervalMs`.
  - Очистка таймеров при отключении.
