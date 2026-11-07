# Diagram legend

Every diagram in an extension's `docs/` folder in this repository is drawn from
the source by the [@taylor/swamp-diagrams](../) extension, so shape and colour
mean the same thing everywhere:

|                     | Meaning                                                                                  |
| ------------------- | ---------------------------------------------------------------------------------------- |
| Teal box            | A phase of a state machine, or a step of a workflow (its behavior and method underneath) |
| Green box           | A final phase, or a phase worth noticing; in a workflow, a step a person must act on     |
| Red box             | A failure phase                                                                          |
| Dashed box          | A workflow step allowed to fail                                                          |
| Double-sided box    | A step that runs another workflow                                                        |
| `↺ method` in a box | A method that keeps the phase where it is (a loop)                                       |
| Blue arrow          | The normal path                                                                          |
| Thick green arrow   | A transition only a person may make                                                      |
| Red arrow           | A step back to an earlier phase (labelled `retry`), or into a failure                    |
| Dotted grey arrow   | A workflow dependency that runs whether or not the step before succeeded (`completed`)   |
| Outer box           | A workflow job; `on worker role=…` says which swamp worker runs it                       |
