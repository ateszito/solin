# Solin staging — nginx web server for the recipe-platform app.
# Build context: a self-contained dir with app/ + VideoContent/ (real files,
# not the git symlink). Serving app/ as the web root means all relative asset
# links (styles.css, *.js, VideoContent/*.mp4) resolve from /.
#
# NOTE on VideoContent: in the repo, app/VideoContent is a git SYMLINK to
# ~/Documents/VideoContent (outside the repo). `docker COPY` does NOT follow
# cross-context symlinks, so the mp4s are missing unless materialized. The
# build MUST be run from a context where app/VideoContent holds real files
# (this repo has a script: `make web-root`, or copy manually before build).
# Baking into the image (vs. a runtime bind mount) is required because a
# bind mount from TCC-protected ~/Documents stalls gvisor container start.
FROM nginx:alpine

COPY app/ /usr/share/nginx/html/

RUN printf 'server {\n  listen 80;\n  root /usr/share/nginx/html;\n  index index.html;\n  include /etc/nginx/mime.types;\n  location / { try_files $uri $uri/ /index.html; }\n}\n' > /etc/nginx/conf.d/default.conf

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
