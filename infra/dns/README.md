# DNS local de desarrollo (dnsmasq en podman rootless) — historia #15

Resuelve `*.inst.ctfrbt.home.arpa` → IP LAN del host de dev (192.168.0.10) y
reenvía el resto de dominios al DNS de la red (192.168.0.53). **Todo rootless,
sin sudo.** NO se usa `.local` (reservado mDNS: avahi/systemd lo interceptan).

Rootless no puede bindear el 53 (`ip_unprivileged_port_start=1024`), así que
el contenedor publica el **5354** del host (UDP+TCP, en `0.0.0.0` → también
alcanzable desde la LAN) y cada máquina configura su DNS como `IP:puerto`.

## Instalar (sin sudo)

```bash
cd <repo>
podman build -t ctfrbt-dns infra/dns
mkdir -p ~/.config/containers/systemd
cp infra/dns/ctfrbt-dns.container ~/.config/containers/systemd/
systemctl --user daemon-reload
systemctl --user enable --now ctfrbt-dns.service
```

Con `Linger=yes` (`loginctl show-user $USER -p Linger`) arranca en cada boot.

## Verificar

```bash
dig +short foo.inst.ctfrbt.home.arpa @192.168.0.10 -p 5354   # -> 192.168.0.10
dig +short google.com @192.168.0.10 -p 5354 | head -3        # ips reales (reenvio)
journalctl --user -u ctfrbt-dns.service -n 20                 # logs
```

## Agregarlo a la red (esta máquina, NetworkManager)

```bash
nmcli connection modify "Static connection" \
  ipv4.dns "192.168.0.10:5354 192.168.0.53" ipv4.dns-priority 50
nmcli connection up "Static connection"
```

(En la GUI de NetworkManager: IPv4 → DNS `192.168.0.10:5354;192.168.0.53`.)

Limitación del esquema con puerto: la opción 6 del DHCP del router **no
transporta puerto**, así que no se reparte a toda la LAN automáticamente;
cada dispositivo que quiera usarlo lo pone en su configuración (Linux
resuelve `IP:puerto`; Windows no soporta DNS en puerto alto → para prod se
usa el dominio real con TLS, historia #14).

## App (dev)

`.env`:

```
GATEWAY_DOMAIN=inst.ctfrbt.home.arpa
GATEWAY_SCHEME=http
GATEWAY_PORT=8088
```

El gateway se publica en `8088:80` (compose) — rootless no binda 80. La regla
Traefik `Host()` casa por hostname y descarta el puerto de la URL. Ver
`stories/15-dns-local-dev.md`.

## Prueba rápida sin quadlet

```bash
podman run -d --name ctfrbt-dns-test -p 0.0.0.0:5354:53/udp -p 0.0.0.0:5354:53/tcp \
  -e DNSMASQ_INTERFACE= localhost/ctfrbt-dns
dig +short foo.inst.ctfrbt.home.arpa @127.0.0.1 -p 5354
podman rm -f ctfrbt-dns-test
```
