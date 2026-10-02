<!-- Сгенерировано. Правьте генератор: src/backend/research/docs-generate.ts
     и перегенерируйте: node --env-file=.env --import=tsx src/backend/research/docs-generate.cli.ts -->

# Архитектура бэкенда

Часть сгенерирована, часть — решение. Ответственности слоёв здесь нет
намеренно: они не измеряются, они объявляются, и объявлять их должен
владелец. Всё, что ниже прочитано из кода, разойтись с ним не может.

## Слои

`вход` — рёбра, входящие в слой, `выход` — исходящие. Рёбра внутри слоя
не считаются: слой, разговаривающий сам с собой, не имеет более широкой
границы, чем та, что у него реально есть.

| слой | файлов | вход | выход | род |
|---|---|---|---|---|
| `types` | 4 | 83 | 0 | сквозной лист |
| `errors` | 3 | 19 | 0 | сквозной лист |
| `config` | 13 | 88 | 5 | сквозной лист |
| `instruments` | 4 | 10 | 2 | сквозной лист |
| `db` | 4 | 30 | 2 | ядро |
| `market` | 16 | 26 | 41 | ядро |
| `indicators` | 21 | 24 | 35 | ядро |
| `strategies` | 11 | 44 | 6 | ядро |
| `signals` | 8 | 14 | 14 | ядро |
| `history` | 11 | 17 | 29 | ядро |
| `outcomes` | 3 | 4 | 11 | ядро |
| `performance` | 6 | 6 | 4 | ядро |
| `analysis` | 2 | 4 | 6 | ядро |
| `backtest` | 14 | 23 | 28 | ядро |
| `services` | 8 | 10 | 61 | составляющий |
| `api` | 25 | 12 | 38 | составляющий |
| `research` | 42 | 0 | 116 | составляющий |
| `observability` | 6 | 23 | 3 | сквозной лист |

### Куда каждый слой импортирует

- `config` → `instruments` (2), `strategies` (1), `types` (2)
- `instruments` → `config` (1), `db` (1)
- `db` → `config` (1), `observability` (1)
- `market` → `config` (16), `errors` (12), `observability` (5), `types` (8)
- `indicators` → `config` (7), `db` (1), `errors` (1), `observability` (3), `types` (23)
- `strategies` → `db` (2), `types` (4)
- `signals` → `config` (8), `db` (1), `indicators` (1), `observability` (1), `types` (3)
- `history` → `config` (7), `db` (3), `errors` (1), `market` (8), `observability` (5), `signals` (1), `types` (4)
- `outcomes` → `config` (4), `db` (1), `signals` (3), `types` (3)
- `performance` → `db` (1), `outcomes` (3)
- `analysis` → `config` (3), `db` (2), `types` (1)
- `backtest` → `config` (14), `indicators` (2), `market` (5), `observability` (1), `signals` (2), `types` (4)
- `services` → `analysis` (4), `config` (7), `db` (2), `history` (11), `indicators` (11), `instruments` (2), `lifecycle` (2), `market` (5), `observability` (3), `outcomes` (1), `signals` (7), `strategies` (3), `types` (3)
- `api` → `config` (9), `db` (1), `errors` (5), `history` (3), `indicators` (3), `instruments` (4), `market` (7), `observability` (2), `services` (2), `signals` (1), `types` (1)
- `research` → `backtest` (23), `config` (4), `db` (10), `indicators` (6), `observability` (1), `performance` (6), `strategies` (39), `types` (27)
- `observability` → `config` (1), `db` (2)

## Циклы

Между слоями: нет.

Внутри слоя: нет.

## Объявленные рёбра, которых нет в коде

Найдено: **0**. Ни одно не разрешено объявлением:
список ниже выведен из данных, а не восстановлен из текста отчёта.


## Зашитый рынок

Упоминаний в комментариях (записи измерений): 148.

Строковых литералов в коде, разрешённый слой: 26.

Строковых литералов в коде, домен: **0**.


Ноль в домене — это не «мы не нашли», а «проверка не может не найти»:
архитектурный lint объявляет, где символ читать можно, и любое другое
чтение попадает в список выше.
