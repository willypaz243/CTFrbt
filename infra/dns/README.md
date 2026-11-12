# DNS local de desarrollo (dnsmasq en podman) — historia #15

Resuelve `*.inst.ctfrbt.home.arpa` → IP LAN del host de dev (192.168.0.10) y
reenvía el resto de dominios al DNS de la red (192.168.0.53). NO se usa `.local`
(reservado mDNS: avahi/systemd-resolved lo interceptan).

Por qué contenedor como **root (quadlet de sistema)**: el puerto 53 es
privilegiado y rootless no puede bindearlo. `interface=enp13s0` hace que no
pise los dnsmasq de libvirt (escuchan en virbr*, no en la LAN).

## Instalar (una vez, con sudo)

```bash
cd <repo>
sudo podman build -t ctfrbt-dns infra/dns
sudo cp infra/dns/ctfrbt-dns.container /etc/containers/systemd/
sudo systemctl daemon-reload
sudo systemctl enable --now ctfrbt-dns.service
```

Verificar:

```bash
dig +short foo.inst.ctfrbt.home.arpa @192.168.0.10   # -> 192.168.0.10
dig +short google.com @192.168.0.10                  # -> ips reales (reenvio)
```

## Usarlo desde esta máquina (sin tocar el router)

```bash
sudo nmcli connection modify "Static connection" \
  ipv4.dns "192.168.0.10 192.168.0.53" ipv4.dns-priority 50
sudo nmcli connection up "Static connection"
```

## Repartirlo a toda la LAN (DHCP del router)

En el admin del router (192.168.0.1), poner el DNS DHCP (option 6) como:
primario `192.168.0.10`, secundario `192.168.0.53` (si el router cae, la red
sigue teniendo DNS). Si el router del ISP no lo permite: configurar por
dispositivo con el comando `nmcli` de arriba.

## App (dev)

`.env`:

```
GATEWAY_DOMAIN=inst.ctfrbt.home.arpa
GATEWAY_SCHEME=http
GATEWAY_PORT=8088
```

El gateway se publica ya en `8088:80` (compose) — rootless no binda 80. La
regla Traefik `Host()` casa por hostname y descarta el puerto de la URL.
Ver `stories/15-dns-local-dev.md`.

## Prueba rootless sin instalar nada (puerto alto, solo localhost)

```bash
podman build -t ctfrbt-dns infra/dns
podman run -d --name ctfrbt-dns-test -p 127.0.0.1:5354:53/udp -p 127.0.0.1:5354:53/tcp \
  -e DNSMASQ_INTERFACE= ctfrbt-dns
dig +short foo.inst.ctfrbt.home.arpa @127.0.0.1 -p 5354
podman rm -f ctfrbt-dns-test
```
