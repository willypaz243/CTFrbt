# DNS local de desarrollo (dnsmasq en podman rootless) — historia #15

> **CONGELADO (v10, 2026-11-12):** el equipo decidió **no usar subdominios/DNS**
> por ahora; el acceso a instancias pasa a **puertos aleatorios**
> (`.opencode/plan/stories/16-canal-puertos-web.md`). Esta infra queda útil para
> desarrollar el canal de gateway (historia #5) en local; **no** la necesitan
> los jugadores ni la red del evento.

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

## Agregarlo a la red (esta máquina)

**Dato duro:** rootless no puede bindear 53 **ni a localhost** (es restricción
de puerto <1024, no de interfaz; `ip_unprivileged_port_start=1024`). Y
**NetworkManager 1.58 rechaza `IP:puerto` en `ipv4.dns`** ("DNS server address
is invalid") salvo con resolvedor stub interno. Tres opciones:

**A) sysctl de una sola línea (recomendada — habilita 53 raíz real y toda la LAN):**

```bash
echo 'net.ipv4.ip_unprivileged_port_start=53' | sudo tee /etc/sysctl.d/60-unprivileged-ports.conf
sudo sysctl --system
sed -i 's/^Environment=DNSMASQ_INTERFACE=/&/' infra/dns/ctfrbt-dns.container   # sin cambios
# en el quadlet: PublishPort=0.0.0.0:5354 -> 0.0.0.0:53 (y en README/story)
systemctl --user daemon-reload && systemctl --user restart ctfrbt-dns.service
nmcli connection modify "Static connection" ipv4.dns "192.168.0.10 192.168.0.53" ipv4.dns-priority 50
nmcli connection up "Static connection"
```

Con esto el router también puede repartir `192.168.0.10` por DHCP a toda la
LAN (option 6 estándar). Contrapartida: cualquier proceso del usuario podrá
bindear puertos ≥53 (aceptable en dev).

**B) Resolvedor interno de NM (`dns=full`, stub en 127.0.0.53:53 con root de NM):**

```bash
sudo mkdir -p /etc/NetworkManager/conf.d && printf '[main]\ndns=full\n' | sudo tee /etc/NetworkManager/conf.d/10-dns-full.conf
sudo systemctl restart NetworkManager
nmcli connection modify "Static connection" ipv4.dns "server:192.168.0.10:5354" ipv4.dns-priority 50
nmcli connection modify "Static connection" ipv4.dns-searches "inst.ctfrbt.home.arpa"
nmcli connection up "Static connection"
```

Solo para esta máquina (resolv.conf → 127.0.0.53); sin=sysctl. La ruta por
dominio (`inst.ctfrbt.home.arpa` → servidor:5354) exige el stub full.

**C) systemd-resolved (inactivo aquí):** habilitarlo + drop-in
`DNS=192.168.0.10:5354`, `Domains=inst.ctfrbt.home.arpa` (mismo efecto B,
más componentes; sudo).

Con A: `nmcli ... ipv4.dns "192.168.0.10 192.168.0.53"` (sin puerto). Con B/C:
UI de red normal (127.0.0.53 lo gestiona NM/resolved).

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
