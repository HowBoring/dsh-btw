# UML diagrams

PlantUML text sources. These are editable design diagrams, not screenshots and not a generated working software implementation.

1. `01_components.puml`: Host/Client components and noninterference boundaries.
2. `02_new_btw_sequence.puml`: main ReAct streaming + BTW admission, persistence and side model response.
3. `03_followup_sequence.puml`: same topic with a fresh current main context snapshot.
4. `04_topic_state_machine.puml`: per-turn lifecycle and persist-first semantics.
5. `05_domain_classes.puml`: conceptual Topic/Turn/ContextCut and service relationships.

Render with a PlantUML installation, or import source into a PlantUML-capable editor. Validate source against the local PlantUML version before publishing implementation docs. Do not treat field names/signatures in diagrams as shipped DSH TypeScript definitions.
