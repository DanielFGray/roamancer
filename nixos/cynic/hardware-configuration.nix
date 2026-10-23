# Generated for the Proxmox VM. disk-config.nix declares the disks.
{ config, lib, pkgs, modulesPath, ... }:
{
  imports = [ (modulesPath + "/profiles/qemu-guest.nix") ];

  boot.initrd.availableKernelModules = [
    "ata_piix"
    "uhci_hcd"
    "virtio_pci"
    "virtio_scsi"
    "sd_mod"
    "sr_mod"
  ];

  # The agent reports guest memory to Proxmox, which then counts page cache as free rather than
  # used. The VM needs `agent: 1` in its Proxmox config as well.
  services.qemuGuest.enable = true;

  nixpkgs.hostPlatform = lib.mkDefault "x86_64-linux";
}
