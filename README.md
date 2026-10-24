# Albion Recipe Book

Every craftable Albion Online item (3,443 items, every tier and enchantment) with its materials, artifacts, amount per craft and focus cost, plus live prices for the Europe server.

- Recipes: [ao-data/ao-bin-dumps](https://github.com/ao-data/ao-bin-dumps) `items.json`, extracted into `recipes.json`.
- Prices: the [Albion Online Data Project](https://www.albion-online-data.com/) API, fetched in your browser when you open an item. They come from players running the Albion Data Client, so some items have no recent price.

It's a single static page (`index.html`) with no build step. To run it locally, serve the folder with any static server, for example `python -m http.server`.
