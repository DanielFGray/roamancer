{ pkgs, ... }:
{
  imports = [
    ./hardware-configuration.nix
    ./nomad-podman.nix
    ./registry.nix
    ./traefik.nix
    ./static-sites.nix
    ./nomad-acl.nix
    ./openbao.nix
    ./herdr.nix
  ];

  boot.loader.grub.enable = true;
  boot.loader.grub.device = "/dev/sda";

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

  users.users.dan = {
    isNormalUser = true;
    shell = pkgs.zsh;
    extraGroups = [ "wheel" ];
    openssh.authorizedKeys.keys = [
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIA4+6wknF8UcGuuWT1U4c0X29YDyRuWuB1b014Hyo57F danielfgray@gmail.com"
    ];
  };

  security.sudo.wheelNeedsPassword = false;

  nix.settings.experimental-features = [ "nix-command" "flakes" ];

  system.stateVersion = "26.05";
}
