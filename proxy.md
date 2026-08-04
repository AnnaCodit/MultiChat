# MultiChat CORS proxy

`proxy.php` — серверный HTTPS-прокси для браузерной версии MultiChat. Он загружает данные YouTube, Kick, VK Video Live и сервисов смайлов, когда браузер не может обратиться к ним напрямую из-за CORS.

Прокси не является открытым универсальным шлюзом: он проксирует только `GET` и отдельно отвечает на CORS preflight `OPTIONS`, разрешает заранее заданные браузерные Origin и обращается только к доменам из `ALLOWED_HOST_SUFFIXES`. Редиректы проверяются повторно, размер ответа ограничен 10 МБ, а сетевые запросы имеют таймауты.

## Размещение

На сервере файлы размещаются так:

- `proxy.php` копируется как `/tools/proxy/index.php`;
- этот файл `proxy.md` копируется как `/tools/proxy/readme.md`.

Публичные адреса:

- прокси: `https://fra3a.ru/tools/proxy/`;
- документация: `https://fra3a.ru/tools/proxy/readme.md`.

Для работы необходимы PHP 7.4+ и расширение cURL. Endpoint должен быть доступен только по HTTPS, иначе браузер заблокирует запросы со страницы GitHub Pages как mixed content.

Публиковать `readme.md` безопасно: файл не содержит ключей, паролей и внутренней конфигурации сервера. Безопасность endpoint не должна зависеть от сокрытия его адреса или принципа работы.

## Использование

Целевой HTTPS URL передаётся в query-параметре `url`:

```text
GET https://fra3a.ru/tools/proxy/?url=https%3A%2F%2Fwww.youtube.com%2F%40channel%2Flive
```

Пример из браузера:

```js
const targetUrl = 'https://www.youtube.com/@channel/live';
const response = await fetch(
  `https://fra3a.ru/tools/proxy/?url=${encodeURIComponent(targetUrl)}`
);
```

Разрешённые браузерные источники задаются в `ALLOWED_ORIGINS`. Сейчас предусмотрены:

- локальный сервер `http://localhost:8088` и `http://127.0.0.1:8088`;
- GitHub Pages `https://annacodit.github.io`;
- `https://fra3a.ru` и `https://www.fra3a.ru`.

Origin содержит только схему, домен и порт — путь GitHub Pages `/MultiChat/` в allowlist не указывается.

## Обслуживание и безопасность

- При добавлении новой платформы добавьте только необходимый доверенный суффикс в `ALLOWED_HOST_SUFFIXES`.
- При изменении адреса фронтенда добавьте его точный Origin в `ALLOWED_ORIGINS`; не используйте `*`.
- CORS ограничивает чтение ответа посторонними сайтами в браузере, но не является авторизацией: запрос можно повторить через `curl`. На публичном сервере рекомендуется дополнительно настроить rate limit средствами веб-сервера или Cloudflare.
- Ошибки и отклонённые запросы записываются в стандартный PHP `error_log` с префиксом `[Proxy]`. Полные тела ответов в лог не попадают.
- После изменения PHP-файла проверьте синтаксис командой `php -l index.php` на сервере.

Основной фронтенд сначала обращается к этому endpoint. Corsproxy.io, AllOrigins и Codetabs используются только как fallback, если собственный прокси недоступен или вернул ошибку.
