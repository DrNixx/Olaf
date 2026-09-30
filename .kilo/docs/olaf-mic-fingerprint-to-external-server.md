# Olaf: микрофон → извлечение отпечатков → мэтчинг на внешнем сервере

> Конспект feasibility-фазы фронтенда `wasm/` (чекаут `D:\Workspace\Friday\acr\olaf\wasm`).
> Фаза завершена, реализация остановлена по указанию владельца: планируется переезд
> в проект с полным репозиторием Olaf (нативные `src/`, `build.zig`, `dataset/`).

## 1. Цель

Используя браузерный фронтенд Olaf:

1. захватить окружающий звук с микрофона;
2. извлечь пару `(t1, hash)` — отпечаток (fingerprint);
3. отправить её на мэтчинг на внешний сервер.

Задача сформулирована в два этапа: сначала определить возможность «в принципе»,
затем реализовывать.

## 2. Что установлено (факты с доказательствами)

### 2.1. Захват микрофона и прогон Olaf уже работают

- `index.html:118-152` и `spectrogram.html:178-186` реализуют полный путь:
  `getUserMedia` (с принудительно выключенным voice processing) →
  `createOlafNode()` → AudioWorklet `olaf-processor` → ресемплинг в 16 кГц →
  `olaf.match()`.
- Обязательные constraints микрофона (voice processing искажает спектральные пики):
  `{ channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false }`.

### 2.2. Экстрактора отпечатков в текущем `js/olaf.wasm` НЕТ

Точный список экспортов (получен инстанцированием модуля в Node, не по строкам в бинаре):

```
_initialize
free
malloc
memory
olaf_fingerprint_match
olaf_wasm_describe
olaf_wasm_set_visualize
```

Импортируемые из JS колбэки (`env`):

```
olaf_fp_matcher_callback   // результаты мэтчинга против вшитой референс-базы
olaf_spectrum_callback     // магнитуды FFT по блокам (только visualize)
olaf_event_point_callback  // (timeIndex, frequencyBin, magnitude) (только visualize)
```

Функции, отдающей пару `(t1, hash)` или список fingerprint-структур, в ABI **нет**.

### 2.3. Апстрим-экстрактор существует, но не проброшен в wasm

В репозитории `JorenSix/Olaf` есть `src/olaf_fp_extractor.h` / `.c`:

- `struct fingerprint { frequencyBin1, timeIndex1, magnitude1, frequencyBin2, timeIndex2,
  magnitude2, frequencyBin3, timeIndex3, magnitude3 }` — сочетание 2–3 event point
  (третий может быть нулевым → фолбэк на 2 точки);
- `olaf_fp_extractor_extract(extractor, eventPoints, audioBlockIndex)` — формирует отпечатки;
- `olaf_fp_extractor_hash(struct fingerprint f) -> uint64_t` — хэш отпечатка (Jenkins-хэш).

Однако кастомный wasm-мост (`src/olaf_wasm.c`) эти функции наружу не выставляет —
в браузер отдан только режим match + visualize. Именно поэтому текущий
`js/olaf.wasm` не умеет отдавать отпечатки.

### 2.4. Чего нет в этом чекауте

- Нет нативных исходников `src/`, `build.zig` → `zig build web` отсюда не выполнить.
- Нет `dataset/` (запрос `../dataset/queries/1051039_34s-54s.mp3` отсутствует) →
  оффлайн-тест `node olaf_wasm_test.mjs` здесь не запускается.
- Есть только `wasm/`; пути `../dataset/…` и `src/…` относятся к родительскому
  репозиторию и «чинить» их не нужно.

## 3. Вывод (feasibility)

| Подзадача | Возможность | Основание |
|---|---|---|
| Извлечь звук с микрофона | ✅ да | `index.html:118-152`, `spectrogram.html:178-186` |
| Ресемплинг в 16 кГц + прогон Olaf | ✅ да | worklet `olaf-processor` + `libsamplerate` |
| Отправить данные на внешний сервер | ✅ да | реализованный пробник + smoke-тест |
| Сформировать `(t1, hash)` в браузере | ❌ нет на текущем `olaf.wasm` | нет экспорта экстрактора (п. 2.2) |

**Итог:** цель достижима, но не целиком на текущем wasm. Единственная реально
извлекаемая наружу полезная нагрузка — **event points**
(`{time_index, frequency_bin, magnitude}`, колбэк `olaf_event_point_callback`,
приходит в главный поток в сообщении `{type:"spectrum"}` при
`createOlafNode(context, { visualize: true })`). Это **вход** для спаривания
в отпечатки, а не сами хэши. `spectrogram.html` уже рисует эти точки.

## 4. Пути достижения цели

### Путь A — пробросить экстрактор в wasm (правильный долгосрочно)

- Правка нативного моста `src/olaf_wasm.c`: добавить экспорт/колбэк, например
  `olaf_wasm_set_extract(1)` + `olaf_fp_callback(hash, timeIndex1, frequencyBin1, …)`,
  вызываемый из пути `olaf_fp_extractor_extract`.
- Пересборка: `zig build web` → новый `js/olaf.wasm`.
- Плюс: настоящие отпечатки прямо в браузере, минимум данных на провод.
- Минус: **в этом чекауте невыполнимо** — нужны нативные `src/` и `build.zig`.

### Путь B — портировать `olaf_fp_extractor.c` в JS

- Спаривать event points в отпечатки на клиенте по логике апстрима
  (правила pairing + `olaf_fp_extractor_hash`).
- Плюс: настоящие хэши без пересборки wasm (все поля EP уже доступны).
- Минус: нужно точно повторить compile-time конфиг (`olaf_config_wasm`) и
  сопровождать ревизию апстрима; риск расхождения с индексом.

### Путь C — формировать `(t1, hash)` на внешнем сервере (рекомендуется)

- Браузер шлёт на сервер **event points**; сервер спаривает их в `(t1, hash)` по
  апстримному `olaf_fp_extractor.c` и матчит против своего индекса.
- Плюс: работает уже сейчас, ничего пересобирать не нужно; индекс и мэтчинг
  логично живут на сервере.
- Минус: на провод уходят EP, а не хэши (EP разрежены, объём умеренный).

## 5. Что уже реализовано (Шаг 1: пробник, Путь C-совместимый)

Три НОВЫХ файла в `wasm/` (существующий код не менялся):

- `js/olaf_ingest.js` — модуль `startIngest({ endpoint, batchSize=64, flushMs=1000, onStatus })`:
  микрофон → `createOlafNode(context, { visualize: true })` → накопление event points →
  батч-отправка `POST` JSON `{ type:"event_points", sessionId, grid, eventPoints }` через `fetch`;
  возвращает `{ stats, stop() }`.
- `feasibility.html` — страница-пробник: поле endpoint (по умолчанию
  `http://localhost:8787/match`), Start/Stop, счётчики, лог; публикует для
  chrome-devtools-MCP: `window.__olaf_ingest_status`, `window.__olaf_ingest_error`,
  `window.__olaf_ingest_stats`.
- `tools/mock_match_server.mjs` — приёмник без зависимостей (порт 8787 / `argv[2]`),
  `POST /match` → лог сводки + `200 {"ok":true,"received":…}`, CORS + `OPTIONS` preflight.

### Как запускать

- Приёмник: `node tools/mock_match_server.mjs` (из `wasm/`).
- Страница (браузер, ручная проверка): поднять статический HTTP-сервер с корнем в
  `wasm/` (не `file://` — нужны ES-модули и AudioWorklet), открыть `/feasibility.html`,
  нажать Start, разрешить микрофон; приёмник должен логировать батчи
  `… N event points …` с N > 0.

### Результаты проверки (Шаг 1)

- `node --check js/olaf_ingest.js` → PASS.
- `node --check tools/mock_match_server.mjs` → PASS.
- Smoke-тест транспорта (сервер + POST синтетического батча) → PASS:
  ответ `{"ok":true,"received":"session smoke: 1 event points, 88 bytes"}`.
- Браузерный прогон с реальным микрофоном — **не проверялся** (нет харнесса
  chrome-devtools-MCP в окружении); результат не выдуман.

### Статус в git

Файлы оставлены как **untracked**, коммит не делался (контракт шага его не требовал;
в дереве присутствовало чужое изменение `AGENTS.md`, которое трогать нельзя).
При необходимости:
`git add feasibility.html js/olaf_ingest.js tools/mock_match_server.mjs` и коммит.

## 6. Следующие шаги (при переезде в полный репозиторий Olaf)

1. Подтянуть полный репозиторий (`src/`, `build.zig`, `dataset/`).
2. Выбрать путь: A (пересборка wasm с экспортом экстрактора) — предпочтителен при
   наличии Zig-тулчейна и контроле над `src/olaf_wasm.c`.
3. Для Пути A — определить точный колбэк/экспорт с полями `(t1, hash)` и пересобрать
   `zig build web`; перенести `js/olaf_ingest.js` на отправку уже готовых отпечатков.
4. Для Пути C — реализовать серверный спариватель по `olaf_fp_extractor.c` и мэтчер;
   браузерный пробник уже готов.
5. Проверка: `node olaf_wasm_test.mjs` (требует `ffmpeg` + `dataset`), затем
   браузерный прогон `/feasibility.html` через chrome-devtools-MCP.

## 7. Ключевые ссылки на код

- `js/olaf_wasm.js:21-107` — ABI: `instantiateOlaf`, колбэки `env`, `match(samples)`.
- `js/olaf_wasm.js:61-80` — `olaf_fp_matcher_callback`, `olaf_spectrum_callback`,
  `olaf_event_point_callback`.
- `js/olaf_processor.js:36-46` — создание Olaf с `visualize`, проброс колбэков в порт.
- `js/olaf_processor.js:88-106` — формирование сообщения `{type:"spectrum", eventPoints}`.
- `js/olaf.js:4-17` — `createOlafNode` (fetch wasm + `addModule`).
- `spectrogram.html:129-156` — работа с grid/spectrum/eventPoints/match.
- `spectrogram.html:178-186` — захват микрофона с корректными constraints.
- `olaf_wasm_test.mjs` — эталон использования ABI в Node (референс id 1051039).
- Апстрим: `src/olaf_wasm.c`, `src/olaf_fp_extractor.c/.h`, `src/olaf_ep_extractor.c/.h`,
  `src/olaf_config.c/.h`.
