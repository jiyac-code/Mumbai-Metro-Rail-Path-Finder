# Mumbai Metro & Rail Path Finder

Finds the fastest route between any two stations on Mumbai's metro and suburban rail network, and shows it on a map. The route is found with **Dijkstra's algorithm, written in C++**.

## Features

- Fastest route between any two stations, with every change and walk listed
- Interactive map with pan and zoom (or click two stations to pick them)
- Search animation that shows how Dijkstra explores the network
- Untick a line to close it and see the route change

## Run it

You need a C++17 compiler and Node.js.

```bash
g++ -std=c++17 -O2 -o metro main.cpp     # on Windows: -o metro.exe
node server.js
```

Then open http://localhost:3000.

## How it works

- `main.cpp` reads `network.txt`, builds the graph and runs Dijkstra.
- `server.js` runs the C++ program and sends its answer to the web page.
- `public/` draws the map and the route.

Each graph node is a **(station, line)** pair, so changing lines costs time. That is what lets Dijkstra pick a faster route over one with fewer stops.

To change the network, edit `network.txt` and refresh the page.

## Limits

- Station coordinates are approximate.
- Travel times are estimates, not timetables.
- Fast trains and the monorail are not included.

Station order and interchanges come from Wikipedia (October 2026).