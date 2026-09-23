# Signal-HUB

## AI-Powered Centralized City Traffic Intelligence & Control Platform

Signal-HUB is a centralized smart-city traffic management platform designed to connect roads, intersections, traffic signals, authorized traffic cameras, traffic-flow data, emergency vehicles, incidents, and traffic-enforcement workflows through a single God's-Eye-style 3D command center.

The project uses the open-source [God's Eye View](https://github.com/bilawalsidhu/gods-eye-view) project as its primary visualization and architectural foundation.

## Vision

Signal-HUB aims to unify:

- City-wide traffic monitoring
- 3D road and intersection visualization
- Traffic congestion analysis
- Adaptive traffic-signal optimization
- Authorized CCTV integration
- Computer-vision vehicle detection
- Emergency-vehicle priority
- Emergency green-corridor simulation
- Configurable traffic-violation detection
- Authorized license-plate recognition workflows
- Evidence and human-review workflows
- Configurable penalty calculations
- Auditable traffic-control events

## Architecture

```text
                    SIGNAL-HUB
                         |
              God's-Eye 3D Command Center
                         |
       +-----------------+-----------------+
       |                 |                 |
       v                 v                 v
 Traffic Engine     Vision Engine    Emergency Engine
       |                 |                 |
       v                 v                 v
 Roads / Flow       CCTV / Video     Emergency Vehicles
 Intersections      Vehicle Vision   Priority Routes
 Signals            Violation AI     Signal Preemption
       |                 |                 |
       +-----------------+-----------------+
                         |
                         v
                 Decision Engine
                         |
              +----------+----------+
              |                     |
              v                     v
       Signal Simulator       Authorized Control
                              Integration Adapter
```

## Core Modules

### Traffic Intelligence

Analyze and visualize:

- Roads
- Vehicle flow
- Traffic density
- Congestion
- Queue length
- Average speed
- Intersections
- Signal states
- Incidents

Data must always be labelled as **LIVE**, **SIMULATED**, **ESTIMATED**, or **UNAVAILABLE**.

### Adaptive Traffic Signals

The traffic engine analyzes vehicle count, queue length, average speed, congestion, intersection pressure, downstream traffic, and emergency priority.

The prototype uses a signal simulator. Real traffic-signal hardware must only be connected through an authorized controller integration.

### Emergency Vehicle Priority

Authorized emergency vehicles such as ambulances and fire engines can receive priority treatment.

The system can:

1. Detect or receive an authorized emergency-vehicle event.
2. Determine its route.
3. Identify upcoming signalized intersections.
4. Prepare an emergency corridor.
5. Safely transition simulated signals.
6. Give priority to the emergency direction.
7. Restore normal/adaptive operation.

The simulator must respect amber and all-red safety transitions.

### CCTV & Computer Vision

The platform is designed to integrate authorized camera feeds for:

- Vehicle detection
- Vehicle classification
- Short-lived scene tracking
- Emergency-vehicle detection
- Traffic-density estimation
- Configurable violation detection

### Traffic Violations

The configurable rule engine can support:

- Red-light violations
- Stop-line violations
- Wrong-way movement
- Illegal turns
- Configured lane violations
- Speed violations where reliable speed data exists

Each violation can contain its type, intersection, camera, timestamp, signal state, vehicle detection, evidence, confidence, and review status.

### Authorized ALPR Workflow

God's Eye View already provides an ALPR-camera infrastructure layer. Signal-HUB can extend this with an authorized vehicle-identification pipeline:

```text
Camera Frame
     |
Vehicle Detection
     |
Vehicle Tracking
     |
Plate Detection
     |
Plate OCR
     |
Confidence Validation
     |
Violation Evidence
     |
Human Review / Authorized Enforcement
```

Low-confidence OCR results must not be guessed.

### Evidence & Enforcement

A violation can produce an auditable evidence record containing:

- Violation ID
- Rule
- Vehicle detection
- Plate result when authorized and available
- Plate confidence
- Camera
- Timestamp
- Intersection
- Signal state
- Evidence frame
- Detection confidence
- Review status

Penalty amounts are configurable by jurisdiction and effective date. The prototype does not independently impose legally binding fines.

## God's Eye View Foundation

Signal-HUB is intended to reuse God's Eye View instead of recreating its geospatial foundation.

Relevant existing capabilities include:

- Cesium-based 3D visualization
- Road and traffic visualization
- Traffic-flow integration
- CCTV source architecture
- Camera health and media handling
- ALPR-camera infrastructure visualization
- Layer-based data architecture
- Server-side provider/proxy patterns
- Application lifecycle management
- Viewport-based performance strategies

New traffic-control, emergency, simulation, violation, and command-center capabilities should extend the existing architecture rather than unnecessarily replacing it.

## Simulation Mode

The project includes a planned demonstration environment that does not require access to physical city infrastructure.

Simulation scenarios:

- Traffic jam
- Peak-hour traffic
- Red-light violation
- Ambulance arrival
- Fire-engine arrival
- Accident
- Signal failure
- Camera failure
- Emergency corridor

Example demonstration:

```text
Traffic increases
      ↓
Congestion detected
      ↓
Signal optimization recommended
      ↓
Signal timing simulated
      ↓
Ambulance detected
      ↓
Emergency route calculated
      ↓
Upcoming intersections identified
      ↓
Emergency preemption simulated
      ↓
Ambulance passes
      ↓
Normal traffic control restored
      ↓
Traffic violation detected
      ↓
Evidence generated
      ↓
Authorized review workflow
```

## Command Center

The main interface is intended to provide:

- 3D city map
- Traffic heatmap
- Intersection control panel
- CCTV panel
- Emergency panel
- Incident panel
- Violation review panel
- Signal-health panel
- Live event timeline
- System-health indicators
- Simulation controls

Operational modes:

1. Overview
2. Live Traffic
3. Intersection Control
4. CCTV
5. Emergency
6. Incidents
7. Violations
8. Signal Health
9. Analytics
10. Simulation
11. Data Sources

## Data Integrity

Signal-HUB must distinguish:

- **LIVE** — obtained from a configured live source.
- **SIMULATED** — generated by the demonstration environment.
- **ESTIMATED** — calculated from available observations.
- **UNAVAILABLE** — source cannot currently provide data.

Simulated information must never be presented as live city information.

## Security & Privacy

Because this platform can process sensitive traffic-camera and enforcement information, the architecture should support:

- Authentication
- Role-based access control
- Operator permissions
- Traffic-control permissions
- Enforcement-review permissions
- Administrative permissions
- Audit logging
- Server-side secret management
- Evidence access controls
- Configurable data retention

The project does not require face recognition or generalized person tracking. Vehicle and plate processing is intended only for authorized traffic-management/enforcement workflows and must comply with applicable laws and policies.

## Development Principles

- Reuse existing God's Eye View functionality before creating replacements.
- Preserve working upstream functionality.
- Keep live and simulated data clearly separated.
- Keep real-world traffic-control integrations behind explicit adapters.
- Require authorization for consequential control actions.
- Maintain an audit trail.
- Never fabricate live traffic or enforcement data.
- Never invent unreadable license-plate characters.
- Keep the system modular and testable.
- Optimize the 3D interface for city-scale performance.

## Project Status

**Early development / architecture phase.**

The repository is being developed into a working prototype of a centralized AI-assisted traffic operations platform.

## Target Outcome

**Road Network + Traffic Intelligence + Signals + CCTV + Computer Vision + Emergency Priority + Incident Management + Authorized Enforcement Workflows**

within one interactive 3D command center.

## References

- God's Eye View: https://github.com/bilawalsidhu/gods-eye-view
- Signal-HUB: https://github.com/tamilarasan-1912/Signal-HUB
