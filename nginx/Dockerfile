# ---------------------------------------------------
# Stage 1: Build the dynamic module
# ---------------------------------------------------
FROM nginx:alpine AS builder

# Install build dependencies
RUN apk add --no-cache \
  gcc \
  libc-dev \
  make \
  openssl-dev \
  pcre-dev \
  zlib-dev \
  linux-headers \
  curl \
  gnupg \
  libxslt-dev \
  gd-dev \
  geoip-dev

# Download the Headers More module source
ENV HEADERS_MORE_VERSION=0.37
RUN curl -fSL "https://github.com/openresty/headers-more-nginx-module/archive/v${HEADERS_MORE_VERSION}.tar.gz" -o headers-more.tar.gz \
  && tar -zxC /tmp -f headers-more.tar.gz

# Download Nginx source matching the running Nginx version
RUN curl -fSL "https://nginx.org/download/nginx-${NGINX_VERSION}.tar.gz" -o nginx.tar.gz \
  && tar -zxC /tmp -f nginx.tar.gz

# Compile the module
WORKDIR /tmp/nginx-${NGINX_VERSION}

# FIX: Extract arguments but strip 'cc-opt' and 'ld-opt' to avoid shell splitting errors
RUN CONFARGS=$(nginx -V 2>&1 | sed -n -e 's/^.*arguments: //p') \
  && CONFARGS=$(echo "$CONFARGS" | sed -r "s/--with-cc-opt='[^']*'//g" | sed -r "s/--with-ld-opt='[^']*'//g") \
  && ./configure --with-compat $CONFARGS --add-dynamic-module=/tmp/headers-more-nginx-module-${HEADERS_MORE_VERSION} \
  && make modules

# ---------------------------------------------------
# Stage 2
# ---------------------------------------------------


FROM nginx:alpine AS builder2

# Install build dependencies
RUN apk add --no-cache \
  gcc \
  libc-dev \
  make \
  openssl-dev \
  pcre-dev \
  zlib-dev \
  linux-headers \
  curl \
  gnupg \
  libxslt-dev \
  gd-dev \
  geoip-dev \
  git \
  cargo \
  clang20-libclang


COPY --from=builder /tmp/nginx-${NGINX_VERSION} /tmp/nginx-${NGINX_VERSION}
WORKDIR /tmp

RUN git clone https://github.com/nginx/nginx-acme && cd nginx-acme \
  && export NGINX_BUILD_DIR=$(realpath ../nginx-${NGINX_VERSION}/objs) \
  && cargo build --release
# ---------------------------------------------------
# Stage 3: Create the final image
# ---------------------------------------------------
FROM nginx:alpine

# 1. Copy the compiled module from the builder stage
COPY --from=builder /tmp/nginx-${NGINX_VERSION}/objs/ngx_http_headers_more_filter_module.so /usr/lib/nginx/modules/
COPY --from=builder2 /tmp/nginx-acme/target/release/libnginx_acme.so /usr/lib/nginx/modules/
# 2. Enable the module in nginx.conf
# We use sed to insert the load_module directive at the top of the file
