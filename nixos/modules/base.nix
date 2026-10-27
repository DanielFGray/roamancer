# What every host shares: boot, SSH, the operator's account, sudo and the operator's shell tools.
{ pkgs, site, ... }:
let
  operator = site.operator;
in
{
  imports = [
    ./proxmox-vm.nix
    ./disk-config.nix
  ];

  # disko sets the GRUB device from disk-config.nix.
  boot.loader.grub.enable = true;

  services.tailscale.enable = true;

  services.openssh = {
    enable = true;
    settings = {
      PasswordAuthentication = false;
      # Without this, sshd still offers keyboard-interactive login, which PAM
      # answers with a password prompt.
      KbdInteractiveAuthentication = false;
      PermitRootLogin = "no";
    };
  };

  programs.zsh.enable = true;

  # Git hosts the bare repositories that builds on a host read from. The rest are the
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

  users.users.${operator.name} = {
    isNormalUser = true;
    shell = pkgs.zsh;
    extraGroups = [ "wheel" ];
    openssh.authorizedKeys.keys = operator.sshKeys;
  };

  # sudo is the line between the operator's shell, which coding agents can reach through
  # the operator's ssh key, and root, which holds the Nomad and OpenBao credentials. Root
  # is locked, so without the operator's password nobody can become root; each host says
  # where that password comes from.
  security.sudo.wheelNeedsPassword = true;

  nix.settings.experimental-features = [ "nix-command" "flakes" ];

  # `ops rebuild` copies the repo's nixos folder here as the operator, then root builds
  # from it. The operator can write here, so the copy and the build run back to back in one
  # command: whatever was here before the copy is replaced, never built.
  systemd.tmpfiles.rules = [ "d /etc/nixos 0755 ${operator.name} root -" ];
}
