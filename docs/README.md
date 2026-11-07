# swampworks docs

Diagrams of the workflows and state machines in this repository, kept up to date
by the [@taylor/swamp-diagrams](../swamp-diagrams/) extension. They are Mermaid,
so GitHub draws them in your light or dark theme.

- [Legend](architecture/legend.md): what the shapes and colours mean
- [@swamp/issue-lifecycle](architecture/issue-lifecycle.md): the swamp-club
  issue state machine
- [@taylor/libvirt](architecture/libvirt.md): set up and check a KVM host,
  create VMs
- [@taylor/roam-graph](architecture/roam.md): periodic Roam reviews
- [@taylor/slidev](architecture/slidev.md): create and publish a Slidev deck

## Updating the diagrams

Each diagram sits between `<!-- swamp-diagram: <name> -->` and
`<!-- /swamp-diagram -->` markers. Write the prose around the markers and leave
the code block between them to the extension. To redraw every diagram after a
workflow changes, run from the repository root:

```sh
docs/update-diagrams.sh
```
