// Mumbai Metro + Suburban Rail path finder.
// All graph building and shortest-path logic lives here. The web page only draws the results.
//
//   metro                                         interactive terminal mode
//   metro --network                               print the network as JSON
//   metro --route <startId> <destId> [offLines]
//         offLines: comma list of line ids to treat as closed, e.g. L1,L3
//
// Data is read from network.txt (see the header of that file for the format and its limits).

#include <algorithm>
#include <cmath>
#include <fstream>
#include <functional>
#include <iostream>
#include <limits>
#include <queue>
#include <set>
#include <sstream>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <utility>
#include <vector>

using namespace std;

struct LineInfo {
    string id, type, name, color;
};

struct Station {
    string id, name, label, type;
    double lat = 0, lon = 0;
    vector<int> nodes;  // one node per line that serves this station
};

struct Node {
    int station;
    int line;
};

struct Edge {
    int to;
    int secs;
    bool transfer;
};

struct Route {
    int line;
    vector<int> stations;
};

struct Link {
    int a, b, minutes;
    string note;
};

struct Network {
    unordered_map<string, double> params;
    vector<LineInfo> lines;
    unordered_map<string, int> lineIndex;
    vector<Station> stations;
    unordered_map<string, int> stationIndex;
    vector<Route> routes;
    vector<Link> links;
    vector<Node> nodes;
    vector<vector<Edge>> adj;
    unordered_map<long long, int> nodeIndex;
};

// ---------- helpers ----------

vector<string> split(const string& s, char sep) {
    vector<string> out;
    string cur;
    for (char c : s) {
        if (c == sep) {
            out.push_back(cur);
            cur.clear();
        } else {
            cur += c;
        }
    }
    out.push_back(cur);
    return out;
}

string trim(const string& s) {
    size_t a = s.find_first_not_of(" \t\r\n");
    if (a == string::npos) return "";
    size_t b = s.find_last_not_of(" \t\r\n");
    return s.substr(a, b - a + 1);
}

double haversineKm(double lat1, double lon1, double lat2, double lon2) {
    const double R = 6371.0;
    const double toRad = M_PI / 180.0;
    double dLat = (lat2 - lat1) * toRad;
    double dLon = (lon2 - lon1) * toRad;
    double a = sin(dLat / 2) * sin(dLat / 2) +
               cos(lat1 * toRad) * cos(lat2 * toRad) * sin(dLon / 2) * sin(dLon / 2);
    return 2 * R * asin(sqrt(a));
}

string jsonStr(const string& s) {
    string out = "\"";
    for (char c : s) {
        switch (c) {
            case '"': out += "\\\""; break;
            case '\\': out += "\\\\"; break;
            case '\n': out += "\\n"; break;
            case '\r': out += "\\r"; break;
            case '\t': out += "\\t"; break;
            default: out += c;
        }
    }
    return out + "\"";
}

// ---------- loading ----------

int nodeFor(Network& net, int station, int line) {
    long long key = static_cast<long long>(station) * 1000 + line;
    auto it = net.nodeIndex.find(key);
    if (it != net.nodeIndex.end()) return it->second;
    int id = static_cast<int>(net.nodes.size());
    net.nodes.push_back({station, line});
    net.adj.emplace_back();
    net.stations[station].nodes.push_back(id);
    net.nodeIndex[key] = id;
    return id;
}

void addEdgePair(Network& net, int a, int b, int secs, bool transfer) {
    for (const Edge& e : net.adj[a]) {
        if (e.to == b) return;  // already connected
    }
    net.adj[a].push_back({b, secs, transfer});
    net.adj[b].push_back({a, secs, transfer});
}

bool loadNetwork(Network& net, const string& path, string& error) {
    ifstream in(path);
    if (!in) {
        error = "Cannot open " + path;
        return false;
    }

    string line;
    int lineNo = 0;
    while (getline(in, line)) {
        lineNo++;
        line = trim(line);
        if (line.empty() || line[0] == '#') continue;

        vector<string> f = split(line, '|');
        const string& kind = f[0];

        if (kind == "PARAM" && f.size() == 3) {
            net.params[f[1]] = stod(f[2]);
        } else if (kind == "LINE" && f.size() == 5) {
            net.lineIndex[f[1]] = static_cast<int>(net.lines.size());
            net.lines.push_back({f[1], f[2], f[3], f[4]});
        } else if (kind == "STATION" && f.size() == 6) {
            Station s;
            s.id = f[1];
            s.name = f[2];
            s.type = f[3];
            s.lat = stod(f[4]);
            s.lon = stod(f[5]);
            net.stationIndex[s.id] = static_cast<int>(net.stations.size());
            net.stations.push_back(s);
        } else if (kind == "ROUTE" && f.size() == 3) {
            if (!net.lineIndex.count(f[1])) {
                error = "Unknown line on line " + to_string(lineNo);
                return false;
            }
            Route r;
            r.line = net.lineIndex[f[1]];
            istringstream ss(f[2]);
            string sid;
            while (ss >> sid) {
                if (!net.stationIndex.count(sid)) {
                    error = "Unknown station '" + sid + "' on line " + to_string(lineNo);
                    return false;
                }
                r.stations.push_back(net.stationIndex[sid]);
            }
            net.routes.push_back(r);
        } else if (kind == "LINK" && f.size() == 5) {
            if (!net.stationIndex.count(f[1]) || !net.stationIndex.count(f[2])) {
                error = "Unknown station in LINK on line " + to_string(lineNo);
                return false;
            }
            net.links.push_back({net.stationIndex[f[1]], net.stationIndex[f[2]], stoi(f[3]), f[4]});
        } else {
            error = "Cannot parse line " + to_string(lineNo);
            return false;
        }
    }

    // Labels: if a metro and a rail station share a name, tag both so the user can tell them apart.
    unordered_map<string, int> nameCount;
    for (const Station& s : net.stations) nameCount[s.name]++;
    for (Station& s : net.stations) {
        s.label = s.name;
        if (nameCount[s.name] > 1) s.label += (s.type == "metro") ? " (Metro)" : " (Rail)";
    }

    // Ride edges. Ride time is estimated from distance, speed and dwell time.
    for (const Route& r : net.routes) {
        const LineInfo& li = net.lines[r.line];
        bool metro = (li.type == "metro");
        double kmh = net.params[metro ? "metro_kmh" : "rail_kmh"];
        double dwell = net.params[metro ? "metro_dwell_s" : "rail_dwell_s"];

        for (size_t i = 0; i + 1 < r.stations.size(); i++) {
            const Station& a = net.stations[r.stations[i]];
            const Station& b = net.stations[r.stations[i + 1]];
            double km = haversineKm(a.lat, a.lon, b.lat, b.lon);
            int secs = max(60, static_cast<int>(lround(km / kmh * 3600.0 + dwell)));
            int na = nodeFor(net, r.stations[i], r.line);
            int nb = nodeFor(net, r.stations[i + 1], r.line);
            addEdgePair(net, na, nb, secs, false);
        }
    }

    // Transfers at a station served by several lines.
    for (const Station& s : net.stations) {
        int secs = static_cast<int>(net.params[s.type == "metro" ? "transfer_metro_s" : "transfer_rail_s"]);
        for (size_t i = 0; i < s.nodes.size(); i++) {
            for (size_t j = i + 1; j < s.nodes.size(); j++) {
                addEdgePair(net, s.nodes[i], s.nodes[j], secs, true);
            }
        }
    }

    // Walking links between differently placed stations.
    for (const Link& l : net.links) {
        for (int na : net.stations[l.a].nodes) {
            for (int nb : net.stations[l.b].nodes) {
                addEdgePair(net, na, nb, l.minutes * 60, true);
            }
        }
    }

    return true;
}

// ---------- search ----------

struct TraceStep {
    int node;
    int cost;
};

struct Result {
    bool found = false;
    vector<int> path;  // node ids
    int secs = 0;
    int rides = 0;
    int transfers = 0;
    int settledCount = 0;
    vector<TraceStep> trace;
};

void finishResult(const Network& net, Result& r, int endNode, const vector<int>& previous) {
    for (int v = endNode; v != -1; v = previous[v]) r.path.push_back(v);
    reverse(r.path.begin(), r.path.end());
    for (size_t i = 0; i + 1 < r.path.size(); i++) {
        for (const Edge& e : net.adj[r.path[i]]) {
            if (e.to == r.path[i + 1]) {
                r.secs += e.secs;
                if (e.transfer) r.transfers++;
                else r.rides++;
                break;
            }
        }
    }
    r.found = true;
}

// Dijkstra's algorithm. Edge cost = estimated travel time in seconds.
Result dijkstra(const Network& net, int start, int dest, const vector<bool>& lineOff) {
    Result r;
    const int INF = numeric_limits<int>::max();
    int n = static_cast<int>(net.nodes.size());

    vector<int> dist(n, INF), previous(n, -1);
    vector<bool> settled(n, false);
    priority_queue<pair<int, int>, vector<pair<int, int>>, greater<pair<int, int>>> pq;

    // Multi-source: every node (line) at the start station begins at cost 0.
    for (int id : net.stations[start].nodes) {
        if (lineOff[net.nodes[id].line]) continue;
        dist[id] = 0;
        pq.push({0, id});
    }

    int endNode = -1;
    while (!pq.empty()) {
        auto [cost, u] = pq.top();
        pq.pop();
        if (settled[u]) continue;  // outdated queue entry
        settled[u] = true;
        r.settledCount++;
        r.trace.push_back({u, cost});

        if (net.nodes[u].station == dest) {
            endNode = u;
            break;
        }

        for (const Edge& e : net.adj[u]) {
            if (settled[e.to] || lineOff[net.nodes[e.to].line]) continue;
            int nc = cost + e.secs;
            if (nc < dist[e.to]) {
                dist[e.to] = nc;
                previous[e.to] = u;
                pq.push({nc, e.to});
            }
        }
    }

    if (endNode != -1) finishResult(net, r, endNode, previous);
    return r;
}

// ---------- legs ----------

struct Leg {
    bool transfer = false;
    int line = -1;
    vector<int> stations;  // ride legs
    int from = -1, to = -1;  // transfer legs
    int secs = 0;
};

vector<Leg> buildLegs(const Network& net, const Result& r) {
    vector<Leg> legs;
    Leg cur;
    bool open = false;

    for (size_t i = 0; i + 1 < r.path.size(); i++) {
        const Node& a = net.nodes[r.path[i]];
        const Node& b = net.nodes[r.path[i + 1]];
        const Edge* edge = nullptr;
        for (const Edge& e : net.adj[r.path[i]]) {
            if (e.to == r.path[i + 1]) {
                edge = &e;
                break;
            }
        }
        if (!edge) continue;

        if (!edge->transfer) {
            if (!open) {
                cur = Leg();
                cur.line = a.line;
                cur.stations.push_back(a.station);
                open = true;
            }
            cur.stations.push_back(b.station);
            cur.secs += edge->secs;
        } else {
            if (open) {
                legs.push_back(cur);
                open = false;
            }
            Leg t;
            t.transfer = true;
            t.from = a.station;
            t.to = b.station;
            t.secs = edge->secs;
            legs.push_back(t);
        }
    }
    if (open) legs.push_back(cur);
    return legs;
}

// ---------- JSON output ----------

int roundMinutes(int secs) { return static_cast<int>(lround(secs / 60.0)); }

void printNetworkJson(const Network& net) {
    cout << "{\"lines\":[";
    for (size_t i = 0; i < net.lines.size(); i++) {
        const LineInfo& l = net.lines[i];
        if (i) cout << ",";
        cout << "{\"id\":" << jsonStr(l.id) << ",\"type\":" << jsonStr(l.type)
             << ",\"name\":" << jsonStr(l.name) << ",\"color\":" << jsonStr(l.color) << "}";
    }
    cout << "],\"stations\":[";
    for (size_t i = 0; i < net.stations.size(); i++) {
        const Station& s = net.stations[i];
        if (i) cout << ",";
        cout << "{\"id\":" << jsonStr(s.id) << ",\"name\":" << jsonStr(s.name)
             << ",\"label\":" << jsonStr(s.label) << ",\"type\":" << jsonStr(s.type)
             << ",\"lat\":" << s.lat << ",\"lon\":" << s.lon << ",\"lines\":[";
        set<string> seen;
        bool first = true;
        for (int nid : s.nodes) {
            const string& lid = net.lines[net.nodes[nid].line].id;
            if (!seen.insert(lid).second) continue;
            if (!first) cout << ",";
            cout << jsonStr(lid);
            first = false;
        }
        cout << "]}";
    }
    cout << "],\"routes\":[";
    for (size_t i = 0; i < net.routes.size(); i++) {
        const Route& r = net.routes[i];
        if (i) cout << ",";
        cout << "{\"line\":" << jsonStr(net.lines[r.line].id) << ",\"stations\":[";
        for (size_t j = 0; j < r.stations.size(); j++) {
            if (j) cout << ",";
            cout << jsonStr(net.stations[r.stations[j]].id);
        }
        cout << "]}";
    }
    cout << "],\"links\":[";
    for (size_t i = 0; i < net.links.size(); i++) {
        const Link& l = net.links[i];
        if (i) cout << ",";
        cout << "{\"a\":" << jsonStr(net.stations[l.a].id) << ",\"b\":" << jsonStr(net.stations[l.b].id)
             << ",\"minutes\":" << l.minutes << ",\"note\":" << jsonStr(l.note) << "}";
    }
    cout << "]}\n";
}

void printResultBody(const Network& net, const Result& r) {
    cout << "\"minutes\":" << roundMinutes(r.secs) << ",\"stops\":" << r.rides
         << ",\"transfers\":" << r.transfers << ",\"path\":[";
    for (size_t i = 0; i < r.path.size(); i++) {
        const Node& n = net.nodes[r.path[i]];
        if (i) cout << ",";
        cout << "{\"station\":" << jsonStr(net.stations[n.station].id)
             << ",\"line\":" << jsonStr(net.lines[n.line].id) << "}";
    }
    cout << "],\"legs\":[";
    vector<Leg> legs = buildLegs(net, r);
    for (size_t i = 0; i < legs.size(); i++) {
        const Leg& l = legs[i];
        if (i) cout << ",";
        if (l.transfer) {
            cout << "{\"type\":\"transfer\",\"from\":" << jsonStr(net.stations[l.from].id)
                 << ",\"to\":" << jsonStr(net.stations[l.to].id)
                 << ",\"minutes\":" << roundMinutes(l.secs) << "}";
        } else {
            cout << "{\"type\":\"ride\",\"line\":" << jsonStr(net.lines[l.line].id)
                 << ",\"minutes\":" << roundMinutes(l.secs) << ",\"stations\":[";
            for (size_t j = 0; j < l.stations.size(); j++) {
                if (j) cout << ",";
                cout << jsonStr(net.stations[l.stations[j]].id);
            }
            cout << "]}";
        }
    }
    cout << "]";
}

void printRouteJson(const Network& net, const Result& dj) {
    if (!dj.found) {
        cout << "{\"found\":false,\"error\":\"No route found with the selected lines running.\"}\n";
        return;
    }
    cout << "{\"found\":true,";
    printResultBody(net, dj);
    cout << ",\"settled\":" << dj.settledCount << ",\"totalNodes\":" << net.nodes.size()
         << ",\"trace\":[";
    for (size_t i = 0; i < dj.trace.size(); i++) {
        const Node& n = net.nodes[dj.trace[i].node];
        if (i) cout << ",";
        cout << "{\"s\":" << jsonStr(net.stations[n.station].id) << ",\"l\":"
             << jsonStr(net.lines[n.line].id) << ",\"c\":" << dj.trace[i].cost << "}";
    }
    cout << "]}\n";
}

// ---------- terminal mode ----------

void printRouteText(const Network& net, const Result& r) {
    cout << "\nTotal: about " << roundMinutes(r.secs) << " min, " << r.rides << " stops, "
         << r.transfers << " change" << (r.transfers == 1 ? "" : "s") << "\n\n";
    for (const Leg& l : buildLegs(net, r)) {
        if (l.transfer) {
            const Station& a = net.stations[l.from];
            const Station& b = net.stations[l.to];
            if (l.from == l.to) cout << "  Change lines at " << a.label << "\n";
            else cout << "  Walk from " << a.label << " to " << b.label << " (~" << roundMinutes(l.secs) << " min)\n";
        } else {
            cout << "  " << net.lines[l.line].name << ": " << net.stations[l.stations.front()].label
                 << " -> " << net.stations[l.stations.back()].label << " (" << l.stations.size() - 1
                 << " stops, ~" << roundMinutes(l.secs) << " min)\n";
        }
    }
    cout << "\nDijkstra settled " << r.settledCount << " of " << net.nodes.size() << " nodes\n";
    cout << "Times are estimates from approximate coordinates, not timetables.\n";
}

int pickStation(const Network& net, const string& prompt) {
    for (;;) {
        cout << prompt;
        string input;
        if (!getline(cin, input)) return -1;
        input = trim(input);
        if (input.empty()) continue;

        bool numeric = all_of(input.begin(), input.end(), ::isdigit);
        if (numeric) {
            int idx = stoi(input) - 1;
            if (idx >= 0 && idx < static_cast<int>(net.stations.size())) return idx;
        } else {
            string needle = input;
            transform(needle.begin(), needle.end(), needle.begin(), ::tolower);
            vector<int> hits;
            for (size_t i = 0; i < net.stations.size(); i++) {
                string hay = net.stations[i].label;
                transform(hay.begin(), hay.end(), hay.begin(), ::tolower);
                if (hay == needle) return static_cast<int>(i);
                if (hay.find(needle) != string::npos) hits.push_back(static_cast<int>(i));
            }
            if (hits.size() == 1) return hits[0];
            if (!hits.empty()) {
                cout << "Several matches, type a number:\n";
                for (int h : hits) cout << "  " << h + 1 << ". " << net.stations[h].label << "\n";
                continue;
            }
        }
        cout << "Not found. Type part of a station name or its number.\n";
    }
}

int runInteractive(const Network& net) {
    cout << "=== Mumbai Metro + Suburban Rail Path Finder ===\n\n";
    for (size_t i = 0; i < net.stations.size(); i++) {
        cout << "  " << i + 1 << ". " << net.stations[i].label << "\n";
    }
    cout << "\n";

    int s = pickStation(net, "Start (name or number): ");
    if (s < 0) return 0;
    int d = pickStation(net, "Destination (name or number): ");
    if (d < 0) return 0;

    if (s == d) {
        cout << "\nYou are already there.\n";
        return 0;
    }

    vector<bool> off(net.lines.size(), false);
    Result r = dijkstra(net, s, d, off);
    if (!r.found) {
        cout << "\nNo route found.\n";
        return 0;
    }
    printRouteText(net, r);
    return 0;
}

int main(int argc, char* argv[]) {
    Network net;
    string error;
    string dataPath = "network.txt";
    if (const char* env = getenv("METRO_DATA")) dataPath = env;

    if (!loadNetwork(net, dataPath, error)) {
        if (argc > 1) cout << "{\"found\":false,\"error\":" << jsonStr(error) << "}\n";
        else cerr << "Error: " << error << "\n";
        return 1;
    }

    if (argc == 2 && string(argv[1]) == "--network") {
        printNetworkJson(net);
        return 0;
    }

    if ((argc == 4 || argc == 5) && string(argv[1]) == "--route") {
        auto s = net.stationIndex.find(argv[2]);
        auto d = net.stationIndex.find(argv[3]);
        if (s == net.stationIndex.end() || d == net.stationIndex.end()) {
            cout << "{\"found\":false,\"error\":\"Unknown station.\"}\n";
            return 0;
        }

        vector<bool> off(net.lines.size(), false);
        if (argc == 5) {
            for (const string& id : split(argv[4], ',')) {
                auto it = net.lineIndex.find(id);
                if (it != net.lineIndex.end()) off[it->second] = true;
            }
        }

        printRouteJson(net, dijkstra(net, s->second, d->second, off));
        return 0;
    }

    return runInteractive(net);
}
