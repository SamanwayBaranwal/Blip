# Blip website

The homepage for Blip: one static page (`index.html`) plus the images in `assets/`. No build step.

## Put it online (free)

**Vercel** (easiest):
1. Go to [vercel.com/new](https://vercel.com/new) and import the `blip` GitHub repo.
2. Set **Root Directory** to `site`. Leave everything else as it is.
3. Click **Deploy**. You get a link like `blip-xyz.vercel.app`.
4. To use your own domain: Project → Settings → Domains → add it, then follow the two DNS lines Vercel shows.

**Cloudflare Pages** works the same way: Workers & Pages → Create → Pages → connect the repo, with **Build output directory** set to `site`.

## Change the screenshots

The images in `assets/` are real Blip screens (light theme) with demo content. Replace any `.jpg` with your own screenshot of the same size and the page picks it up.
