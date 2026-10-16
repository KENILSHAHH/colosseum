# PayI intro video

`payi-intro.mp4`: 30 s, 1920×1080, 30 fps, with music. The colours follow the Solana gradient, from purple #9945FF to green #19FB9B.

| Time | Scene |
|---|---|
| 0–4 s | Wordmark and tagline |
| 4–13.5 s | Chat demo: a 3x ETH long on Hyperliquid, then buying TSLA on Robinhood Chain |
| 13.5–19.5 s | Features: perps, stock tokens, Aave, LI.FI and Relay, Solana, jobs |
| 19.5–24.4 s | Google sign-in, one wallet, no gas, supported chains |
| 24.4–27.5 s | Safety and 0.01 USD per prompt |
| 27.5–30 s | End card: app.payi.finance |

`index.html` is the source. It uses the fonts and icons in `apps/web/public`, and every frame is a pure function of time (`render(t)`). Open `index.html?t=12` to see one frame.

The music is an original track that `music.py` synthesizes with numpy: chill synthwave at 120 BPM in A minor. The drums drop in at 4 s with the chat demo, and the groove fills out at 13.5 s with the features. It eases off at 24 s and ends on a held chord under the end card.

Render it again:

```bash
npx http-server -p 8765 -s .          # from the repo root
node media/intro-video/render.mjs     # writes payi-intro.mp4 (needs playwright, ffmpeg, python3 and numpy)
node media/intro-video/render.mjs 5 20  # writes still-5.png and still-20.png
```
