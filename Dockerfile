# syntax=docker/dockerfile:1
# Self-host MuseEncore (viewer + editor + landing page) with nginx.
# Build context must contain the MuseScore submodule (run `git submodule update --init`).
FROM node:24-bookworm AS builder

WORKDIR /app
COPY . .

# The editor bundles MuseScore's templates, translations and soundfont from the submodule.
RUN if [ ! -f MuseScore/share/sound/MS\ Basic.sf3 ]; then \
      echo "ERROR: MuseScore submodule is missing. Run 'git submodule update --init' before building." >&2; \
      exit 1; \
    fi

RUN npm ci

# Build the viewer, the editor, the viewer package and the landing page (mirrors .github/workflows/pages.yml).
RUN mkdir -p _site \
 && npx vite build viewer --base=/viewer/ --outDir ../_site/viewer \
 && npx vite build editor --base=/editor/ --outDir ../_site/editor

RUN npm run build:viewer-package \
 && mkdir -p _site/viewer-package \
 && cp -R packages/viewer/dist packages/viewer/fonts packages/viewer/example _site/viewer-package/ \
 && cp MuseScore/demos/Amazing_grace.mscz _site/viewer-package/example/score.mscz

RUN VERSION=$(node -p "require('./package.json').version") \
 && sed "s/__VERSION__/${VERSION}/g" .github/pages/index.html > _site/index.html \
 && cp logo/muse-encore-logo.svg _site/logo.svg \
 && touch _site/.nojekyll

# ---- runtime ----
FROM nginx:1.27-alpine AS runtime

COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/_site /usr/share/nginx/html

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1/ >/dev/null 2>&1 || exit 1