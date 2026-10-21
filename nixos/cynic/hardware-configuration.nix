# Generated for the Proxmox VM. Re-run nixos-generate-config after hardware changes.
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

  fileSystems."/" = {
    device = "/dev/disk/by-uuid/ab5cf0b4-4a53-4ab9-8be4-fc96905e2a7e";
    fsType = "ext4";
  };

  swapDevices = [
    { device = "/dev/disk/by-uuid/c2bff23c-d724-4bbc-abd7-4615362a96e9"; }
  ];

  nixpkgs.hostPlatform = lib.mkDefault "x86_64-linux";
}
