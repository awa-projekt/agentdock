# AGENTS.md

Use effect vitest and run tests via vitest not bun test

Don't add any backwards compatibility shims for any changes.

Don't add any extra db migration logic yet. Just reset the db if necessary.

code is very cheap to write. do not give time estimates with agents code is practically instant to generate therefore unless stated otherwise time to implement is not a blocker

you have repos in .references like effect, effect-atom. if you are given a git url clone it into that directory to explore it. if you need to know about good patterns look in there

Most of the time i have the dev server already running in a separate tmux pane, so check before trying to start one yourself.

ALWAYS kill your the dev server if you started one and are done with your task.

Do not overwrite the minimum age when installing packages.

<!-- effect-solutions:start -->
## Effect Best Practices

**IMPORTANT:** Always consult effect-solutions before writing Effect code.

1. Run `effect-solutions list` to see available guides
2. Run `effect-solutions show <topic>...` for relevant patterns (supports multiple topics)
3. Search `~/.local/share/effect-solutions/effect` for real implementations

Topics: quick-start, project-setup, tsconfig, basics, services-and-layers, data-modeling, error-handling, config, testing, cli.

Never guess at Effect patterns - check the guide first.

## Local Effect Source

The Effect v4 repository is cloned to `~/.local/share/effect-solutions/effect` for reference.
Use this to explore APIs, find usage examples, and understand implementation details when the documentation isn't enough.
<!-- effect-solutions:end -->
