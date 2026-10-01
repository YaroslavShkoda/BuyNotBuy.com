<!-- Сгенерировано. Правьте генератор: src/backend/research/docs-generate.ts
     и перегенерируйте: node --env-file=.env --import=tsx src/backend/research/docs-generate.cli.ts -->

# HTTP-поверхность

Прочитано из вызовов регистрации в `api/routes`. Таблица, написанная руками,
перечисляет намерения; эта перечисляет то, что процесс регистрирует.

| метод | путь | модуль |
|---|---|---|
| `GET` | `/api/analysis` | `api/routes/analysis.ts` |
| `GET` | `/api/instruments` | `api/routes/instruments.ts` |
| `GET` | `/api/instruments/:ticker` | `api/routes/instruments.ts` |
| `GET` | `/api/instruments/:ticker/analysis` | `api/routes/instruments.ts` |
| `GET` | `/api/market` | `api/routes/market.ts` |
| `GET` | `/api/price` | `api/routes/price.ts` |
| `GET` | `/api/signal-history` | `api/routes/signal-history.ts` |
| `GET` | `/healthz` | `api/routes/health.ts` |
| `GET` | `/metrics` | `api/routes/health.ts` |
| `GET` | `/readyz` | `api/routes/health.ts` |

## Что здесь заморожено, а что добавлено

Четыре маршрута заморожены контрактом фронтенда в `src/app/**`:
`/api/analysis`, `/api/market`, `/api/price`, `/api/signal-history`.
Маршруты про инструменты добавлены рядом с ними и не меняли ни одного из
них — пара «старый + новый» это слой совместимости по замыслу, а не долг.

`/api/market` читает настроенный рынок, потому что для этого он и построен,
и параметра у него нет. `/api/instruments/:ticker` называет один инструмент
явно — и это единственный способ спросить про второй рынок.
