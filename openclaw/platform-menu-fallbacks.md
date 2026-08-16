# Platform Menu Fallbacks

If a chat platform does not support a native dropdown or command menu, use `/ppo menu` and `/ppo help` as text-based fallbacks.

## Telegram

Preferred:

- native command menu
- future inline buttons

Fallback:

- `/ppo menu`
- `/ppo help`

## Discord

Preferred:

- slash commands if supported by the bot setup
- grouped help responses

Fallback:

- `/ppo menu`
- `/ppo help`

## Slack

Preferred:

- slash commands
- shortcuts or app home in future phases

Fallback:

- `/ppo menu`
- `/ppo help`

## WhatsApp

Preferred:

- simple text commands

Fallback:

- `/ppo menu`
- `/ppo help`

Important: early phases must not send direct WhatsApp/customer replies automatically.

## Signal

Preferred:

- simple text commands

Fallback:

- `/ppo menu`
- `/ppo help`

## Generic chat platforms

Preferred:

- exact text commands from the command registry

Fallback:

- `/ppo menu`
- `/ppo help`

## Output rule

All fallback menus should be short enough to read on a phone. Use command groups and avoid long explanations unless the user asks for `/ppo help`.
