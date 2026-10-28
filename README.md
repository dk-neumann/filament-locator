# Filament Locator

A small web app that finds 3D-printer filament on a shelf. It lists your spools from
[Spoolman](https://github.com/Donkie/Spoolman), and when you tap one, it lights that spool's
slot on an addressable LED strip driven by [WLED](https://kno.wled.ge/).

- A spool's slot is its Spoolman **Location** field, written as `rack-shelf-position` (e.g. `2-C-3`).
- Slots are assigned from the app; it writes the Location back to Spoolman.
- Each slot lights in the spool's own filament color (very dark filament lights white).
- Search and filter by name, brand, material or slot; a rack view shows what's in every slot.

No dependencies beyond Node 18+. Runs in Docker alongside Spoolman.

## What you need

- Spoolman running somewhere on your network
- A WLED controller (tested with a BTF-LIGHTING SP805E) driving WS2812B strips along the shelves
- A slot map (`filament-slots.json`) made with the companion
  [Filament Slot Mapper](https://github.com/dk-neumann/filament-slot-mapper), which records which LEDs sit under each slot

## Install

On the machine that runs Docker (e.g. the Raspberry Pi running Spoolman):

```bash
git clone https://github.com/dk-neumann/filament-locator.git
cd filament-locator
cp .env.example .env        # then edit .env: set WLED_HOST to your controller's IP
cp /path/to/your/filament-slots.json data/
docker compose up -d --build
```

Open `http://<docker-host>:7920` in a browser.

No slot map yet? Copy `data/filament-slots.example.json` to `data/filament-slots.json`
to try it with a single example rack.

## Settings (`.env`)

| Setting | Default | Meaning |
|---|---|---|
| `WLED_HOST` | `wled.local` | WLED controller IP or hostname (an IP is more reliable inside Docker) |
| `SPOOLMAN_URL` | `http://localhost:7912` | Spoolman address |
| `PORT` | `7920` | Web port |
| `AUTO_OFF_SECONDS` | `120` | Lights turn off after this many seconds; `0` = never |
| `BRIGHTNESS` | `150` | LED brightness, 1–255 |
| `LIGHT_COLOR` | `filament` | `filament` for each spool's color, or a fixed hex like `FFFFFF` |

After changing `.env`, run `docker compose up -d`.

## Updating the slot map

Export a new `filament-slots.json` from the mapper and copy it into `data/`.
It's re-read on every request, so no restart is needed.

## Updating the app

```bash
git pull
docker compose up -d --build
```

## License

MIT — see [LICENSE](LICENSE).
