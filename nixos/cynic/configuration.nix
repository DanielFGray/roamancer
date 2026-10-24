{ pkgs, ... }:
{
  imports = [
    ./hardware-configuration.nix
    ./disk-config.nix
    ./nomad-podman.nix
    ./registry.nix
    ./traefik.nix
    ./static-sites.nix
    ./nomad-acl.nix
    ./openbao.nix
    ./herdr.nix
    ./backups.nix
  ];

  # disko sets the GRUB device from disk-config.nix.
  boot.loader.grub.enable = true;

  networking.hostName = "cynic";
  networking.networkmanager.enable = true;
  services.tailscale.enable = true;

  services.openssh = {
    enable = true;
    settings = {
      PasswordAuthentication = false;
      PermitRootLogin = "no";
    };
  };

  programs.zsh.enable = true;

  # Git hosts the bare repositories that builds on this host read from. The rest are the
  # command-line tools that the dotfiles' shell configs and the operator's workflow call.
  environment.systemPackages = with pkgs; [
    git
    ripgrep
    fd
    jq
    hyperfine
    ast-grep
    neovim
    fzf
    zoxide
    bat
    lsd
    tree
    rsync
    lsof
    psmisc
    htop
  ];

  users.groups.alchemy = { };

  users.users.dan = {
    isNormalUser = true;
    shell = pkgs.zsh;
    extraGroups = [ "wheel" "alchemy" ];
    openssh.authorizedKeys.keys = [
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIA4+6wknF8UcGuuWT1U4c0X29YDyRuWuB1b014Hyo57F danielfgray@gmail.com"
    ];
  };

  # sudo is the line between dan's shell, which coding agents can reach through dan's ssh
  # key, and root, which holds the Nomad and OpenBao tokens. The password lives only in
  # /etc/shadow (users.mutableUsers), set with `sudo passwd dan` before this takes effect:
  # root is locked, so without it nobody can become root. A fresh install has no password
  # either, so the install has to deliver one.
  security.sudo.wheelNeedsPassword = true;

  nix.settings.experimental-features = [ "nix-command" "flakes" ];

  system.stateVersion = "26.05";
}
