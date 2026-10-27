#!/bin/sh
# Assembles the build base's root filesystem: a shell, the glibc runtime, CA certificates,
# and the baseline bun. Run on cynic. The store paths come from cynic's pinned nixpkgs.
# The bun input is the baseline binary from the npm package @oven/bun-linux-x64-baseline@1.4.3,
# extracted to $bun. The baseline build runs on CPUs without AVX2, which the QEMU default CPU lacks.
# Store paths here are tied to cynic's nixpkgs pin. Update them when the pin changes.
set -eu

busybox=/nix/store/ynylhx93wdwqnw41qfn57pw4d3rakpi7-busybox-static-x86_64-unknown-linux-musl-1.37.0
glibc=/nix/store/fsd4vbp9zjd9iaicq2fb9lpc1h5j973y-glibc-2.42-100
cacert=/nix/store/6x3vic5vm4jzp29yna1qkp0xmf3qm35i-nss-cacert-3.126
gccLib=/nix/store/dqj57l1prad38vjrad4bs9d977i4q5zm-gcc-15.3.0-lib
bun=/srv/build/bin/bun
root=/srv/build/base/rootfs

rm -rf "$root"
mkdir -p "$root/bin" "$root/lib" "$root/lib64" "$root/usr/local/bin" \
  "$root/etc/ssl/certs" "$root/root" "$root/tmp"
chmod 1777 "$root/tmp"

# busybox provides the shell and the coreutils that RUN steps use.
cp "$busybox/bin/busybox" "$root/bin/busybox"
for applet in $("$busybox/bin/busybox" --list); do
  ln -sf busybox "$root/bin/$applet"
done

# The glibc runtime and the name-service libraries that hostname lookups load.
for lib in libc.so.6 libm.so.6 libdl.so.2 librt.so.1 libpthread.so.0 libresolv.so.2 \
  libnss_files.so.2 libnss_dns.so.2; do
  cp -L "$glibc/lib/$lib" "$root/lib/$lib"
done
cp -L "$glibc/lib/ld-linux-x86-64.so.2" "$root/lib64/ld-linux-x86-64.so.2"

printf 'root:x:0:0:root:/root:/bin/sh\n' > "$root/etc/passwd"
printf 'root:x:0:\n' > "$root/etc/group"
printf 'hosts: files dns\n' > "$root/etc/nsswitch.conf"
cp -L "$cacert/etc/ssl/certs/ca-bundle.crt" "$root/etc/ssl/certs/ca-certificates.crt"

# Native addons such as rolldown load the gcc runtime.
cp -L "$gccLib/lib/libgcc_s.so.1" "$gccLib/lib/libstdc++.so.6" "$root/lib/"

# The baseline bun needs only glibc. Point its loader at the path inside this image.
cp "$bun" "$root/usr/local/bin/bun"
nix shell --inputs-from "$HOME/server-ansible/nixos" nixpkgs#patchelf -c \
  patchelf --set-interpreter /lib64/ld-linux-x86-64.so.2 --set-rpath /lib "$root/usr/local/bin/bun"

echo "rootfs assembled at $root"
