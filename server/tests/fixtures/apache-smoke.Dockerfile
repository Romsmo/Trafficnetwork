# CI-only image for .github/workflows/server-ci.yml's Apache reverse-proxy
# smoke test. Enables the three modules mod_proxy_wstunnel needs (present in
# the base image but commented out by default) and includes the smoke-test
# vhost. Not for operator use — see server/deploy/apache.conf for the real,
# TLS-enabled example.
FROM httpd:2.4-alpine
RUN sed -i \
      -e 's/#LoadModule proxy_module/LoadModule proxy_module/' \
      -e 's/#LoadModule proxy_http_module/LoadModule proxy_http_module/' \
      -e 's/#LoadModule proxy_wstunnel_module/LoadModule proxy_wstunnel_module/' \
      conf/httpd.conf \
 && echo "Include conf/extra/proxy-smoke.conf" >> conf/httpd.conf
COPY apache-smoke.conf /usr/local/apache2/conf/extra/proxy-smoke.conf
