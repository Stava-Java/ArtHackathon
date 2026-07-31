# Boxing Canvas

## Inspiration

Boxing and painting both leave evidence of motion. A punch has direction, speed, weight, and timing. A brushstroke has the same qualities. That overlap became the starting point for **Boxing Canvas**: a boxing match where the fight produces the artwork.

We were also interested in a question from the hackathon theme: what kind of art needs technology to exist? A finished digital painting would not be enough. We wanted the code to participate in the performance. The player, the opponent, the physics, the camera, and the sound system all contribute to a piece that is generated during the match and cannot be reproduced stroke for stroke.

## What the project does

The player fights El Chupacabra inside a 3D boxing ring. Jabs, hooks, stretch punches, parries, dashes, and projectiles each create different marks. Their position, color, size, direction, and energy come from the combat event that produced them. The arena starts as a fighting space and gradually becomes a moving canvas.

The same actions also make music. Successful hits climb through a C Lydian Dominant scale:

\[
C, D, E, F\sharp, G, A, B\flat, C
\]

The combo can continue for 20 hits, with a six-second window between successful attacks. Jabs use short sampled mallet strikes. Hooks add a lower in-scale tone and a physical body thump. Stretch punches sweep upward into the current combo note. Parries, paint shots, and damage each have separate sound materials. Later hits use harder xylophone recordings, so the sequence gains force through timbre and pitch instead of unchecked volume.

## How we built it

The project is a browser-based React and TypeScript application built with Vite. Three.js renders the ring, characters, lighting, camera, and imported GLB animations. A combat state system coordinates movement, attack timing, collision windows, health, opponent behavior, visual impact effects, and the final artwork.

The paint system turns game data into visual parameters. An attack supplies an impact point, gesture type, strength, and color. Those values control the emitted shapes, particles, trails, splashes, and camera response. This keeps the artwork tied to what happened in the fight instead of placing random decoration over the screen.

Tone.js handles the auditory layer. The first version used oscillators and several built-in synths, but the combo melody sounded too electronic. We replaced it with two velocity layers of CC0 xylophone recordings loaded through `Tone.Sampler`. `MembraneSynth`, `FMSynth`, `MetalSynth`, and filtered noise still provide the body thumps, charged sweeps, parry shimmer, and impact cracks. Compression and a limiter keep stacked sounds under control.

## Challenges

The hardest design problem was keeping combat, painting, and music connected. If the effects were too random, the project felt like a boxing game with a visualizer attached. If every punch produced the same mark and note, the system became predictable. We ended up giving each gesture its own visual and sonic grammar while keeping one shared combo scale.

Audio took several rounds of revision. The original combo began too low, climbed too quietly, and used a fat sine oscillator that made the whole sequence sound like an arcade synthesizer. Moving the notes into a brighter register helped, but recorded mallet samples made the larger difference. We then capped the gain curve, used soft and hard sample layers, and let later combo stages feel stronger without making the output unsafe.

Browser behavior created another constraint. Audio cannot begin until the player interacts with the page, so the start flow has to initialize the audio context and finish loading the reverb and samples before playing the opening phrase. We also rebuilt the project as a plain Vite application after a deployment expected Next.js and failed to detect it.

Performance required restraint. The scene combines animated 3D models, particles, paint effects, UI, and real-time audio. We reused audio nodes, limited effect lifetimes, kept the sample set small, and used sparse note mapping so Tone.js could pitch nearby recordings instead of loading an entire instrument library.

## What we learned

Building the front-end UI taught us how hard it is to make a screen look intentional while it sits on top of a moving 3D game. The title, health bars, controls, combo meter, start screen, and sound wordmark all had to remain readable without covering the ring or distracting from the paint effects. A layout that worked on desktop could wrap badly or push the Start button off-screen on mobile, and every new visual element changed the spacing somewhere else. We spent more time than expected adjusting responsive sizes, layering, contrast, typography, pointer behavior, and safe areas. Front-end work is not finished when each component works by itself; it is finished when all of them still work together at different screen sizes and during every game state.
