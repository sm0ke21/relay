# bash completion for relay. Install: eval "$(relay completion bash)" in ~/.bashrc
_relay() {
  local cur=${COMP_WORDS[COMP_CWORD]}
  if (( COMP_CWORD == 1 )); then
    if [[ $cur == -* ]]; then
      COMPREPLY=($(compgen -W "--lead --worker --escalate --effort --concurrency --rounds --max-tasks --max-escalations --budget --permission-mode --allow --yolo --inherit-mcp --mcp-config --cwd --out --plain --mock --keep-sessions --detach --idle-timeout --help" -- "$cur"))
    else
      COMPREPLY=($(compgen -W "attach ls logs kill completion" -- "$cur"))
    fi
    return
  fi
  case ${COMP_WORDS[1]} in
    attach|a) (( COMP_CWORD == 2 )) && COMPREPLY=($(compgen -W "$(relay __complete ids 2>/dev/null)" -- "$cur")) ;;
    logs) COMPREPLY=($(compgen -W "-f --follow $(relay __complete ids 2>/dev/null)" -- "$cur")) ;;
    kill) COMPREPLY=($(compgen -W "--all $(relay __complete ids 2>/dev/null)" -- "$cur")) ;;
    completion) COMPREPLY=($(compgen -W "zsh bash" -- "$cur")) ;;
  esac
}
complete -o default -F _relay relay
