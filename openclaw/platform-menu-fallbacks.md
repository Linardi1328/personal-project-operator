# Platform Menu Fallbacks

If a chat platform does not support a native dropdown or command menu, use `/menu` and `/help` as text-based fallbacks.

## Telegram

Preferred:

- native command menu
- future inline buttons

Fallback:

- `/menu`
- `/help`

## Discord

Preferred:

- slash commands if supported by the bot setup
- grouped help responses

Fallback:

- `/menu`
- `/help`

## Slack

Preferred:

- slash commands
- shortcuts or app home in future phases

Fallback:

- `/menu`
- `/help`

## WhatsApp

Preferred:

- simple text commands

Fallback:

- `/menu`
- `/help`

Important: early phases must not send direct WhatsApp/customer replies automatically.

## Signal

Preferred:

- simple text commands

Fallback:

- `/menu`
- `/help`

## Generic chat platforms

Preferred:

- exact text commands from the command registry

Fallback:

- `/menu`
- `/help`

## Output rule

All fallback menus should be short enough to read on a phone. Use command groups and avoid long explanations unless the user asks for `/help`.

