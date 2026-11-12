#!/bin/sh
# Genera la config dinamica desde env y arranca dnsmasq en primer plano.
set -eu

CONF=/etc/dnsmasq.d/99-ctfrbt.conf
{
  echo "address=/${DNSMASQ_WILDCARD_DOMAIN}/${DNSMASQ_WILDCARD_IP}"
  echo "server=${DNSMASQ_UPSTREAM}"
  if [ -n "$DNSMASQ_INTERFACE" ]; then
    echo "interface=${DNSMASQ_INTERFACE}"
    echo "listen-address=${DNSMASQ_WILDCARD_IP}"
  fi
} >"$CONF"

echo "[ctfrbt-dns] dominio=*.${DNSMASQ_WILDCARD_DOMAIN} -> ${DNSMASQ_WILDCARD_IP} | upstream=${DNSMASQ_UPSTREAM} | interface=${DNSMASQ_INTERFACE:-todas}"
exec dnsmasq --no-daemon --conf-dir=/etc/dnsmasq.d
