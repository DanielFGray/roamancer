#!/usr/bin/env bash

uri=qemu:///system

virsh="virsh -c $uri"
list="$virsh list --all"

$list | fzf --header-lines=2 --track --id-nth=1 --header='enter=console  ctrl-r=reboot  ctrl-x=destroy  ctrl-s=start  ctrl-p=pause/resume' \
  --preview="$virsh"' dominfo {2}; echo; '"$virsh"' dommemstat {2}' \
  --bind='every(2):reload-sync('"$list"')+refresh-preview' \
  --bind='ctrl-r:execute('"$virsh"' reboot {2})+reload('"$list"')' \
  --bind='ctrl-x:execute('"$virsh"' destroy {2})+reload('"$list"')' \
  --bind='ctrl-s:execute('"$virsh"' start {2})+reload('"$list"')' \
  --bind='ctrl-p:execute(if '"$virsh"' domstate {2} | grep -q paused; then '"$virsh"' resume {2}; else '"$virsh"' suspend {2}; fi)+reload('"$list"')' \
  --bind='enter:become('"$virsh"' console {2})'
