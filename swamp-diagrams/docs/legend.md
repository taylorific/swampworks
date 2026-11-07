# Diagram legend

Every diagram in an extension's `docs/` folder in this repository is drawn from
the source by the [@taylor/swamp-diagrams](../) extension, so shape and colour
mean the same thing everywhere. Each is a light and a dark SVG, shown to match
your GitHub theme.

|                        | Meaning                                                                                |
| ---------------------- | -------------------------------------------------------------------------------------- |
| Teal box               | A phase of a state machine, or a step of a workflow                                    |
| Green box              | A final phase, or one worth noticing; in a workflow, a step a person must act on       |
| Red box                | A failure phase, drawn beside the phase that leads to it                               |
| Dashed box             | A workflow step allowed to fail                                                        |
| Double-bordered box    | A step that runs another workflow                                                      |
| Grey text beside a box | A phase's note, or the behavior and method a step runs                                 |
| Blue arrow             | The normal path, straight down the middle                                              |
| Thick green arrow      | A transition only a person may make                                                    |
| Red arrow              | Into a failure, or back to an earlier phase (labelled `retry`)                         |
| Amber loop             | Methods that keep a phase where it is                                                  |
| Dashed grey arrow      | A workflow dependency that runs whether or not the step before succeeded (`completed`) |
| Dashed frame           | A workflow job; `on worker …` says which swamp worker runs it                          |
