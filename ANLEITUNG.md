# PaintBot Steuerpult – Einrichtung und Bedienung

Die App ist eine Webseite, die sich per Bluetooth direkt mit dem Roboter verbindet.
Sie läuft am PC und am Handy. Damit das Handy Bluetooth im Browser freigibt, muss die
Seite über eine **https-Adresse** kommen – dafür wird sie einmalig kostenlos auf
GitHub Pages abgelegt.

## Voraussetzungen

- Firmware **V16** auf dem Roboter. Ältere Firmware versteht die Tasten der App, aber
  nicht die direkte Muster- und Kunstauswahl und kein Bild in Menü 2.
- Browser:

  | Gerät | Browser |
  |---|---|
  | PC (Windows 10/11, macOS) | Chrome oder Edge |
  | Android | Chrome |
  | iPhone / iPad | App **Bluefy** aus dem App Store (Safari und Chrome auf dem iPhone können kein Bluetooth) |

- Der Roboter nimmt **nur eine Bluetooth-Verbindung** gleichzeitig an. Vorher die
  Bluefruit-App trennen bzw. schließen.

## Einmalig: auf GitHub Pages veröffentlichen

1. Auf <https://github.com/signup> ein kostenloses Konto anlegen (falls noch keins da ist).
2. Oben rechts **+ → New repository**. Name: `paintbot`, Sichtbarkeit **Public**
   (GitHub Pages ist im kostenlosen Konto nur für öffentliche Repositories frei).
   **Create repository**.
3. Auf der neuen Seite **uploading an existing file** anklicken und alle Dateien
   aus diesem Ordner hineinziehen:
   `index.html`, `app.js`, `art-gen.js`, `manifest.webmanifest`, `sw.js`, `icon.svg`,
   `icon-192.png`, `icon-512.png` (`README.md` und diese Anleitung können mit). **Commit changes**.
4. **Settings → Pages**. Unter *Build and deployment*: Source **Deploy from a
   branch**, Branch **main**, Ordner **/ (root)**, **Save**.
5. Nach ein bis zwei Minuten steht dort die Adresse, z. B.
   `https://DEINNAME.github.io/paintbot/`. Diese Adresse am PC und am Handy öffnen.

Die Seite ist öffentlich erreichbar, enthält aber keine Daten. Steuern kann den
Roboter nur, wer in Bluetooth-Reichweite ist und die Verbindung im Browser bestätigt.

**Als App aufs Handy:** Android-Chrome → Menü ⋮ → *App installieren* bzw. *Zum
Startbildschirm hinzufügen*. In Bluefy die Adresse als Lesezeichen speichern.

**Neue Version:** Im Repository erneut *Add file → Upload files*, die geänderten
Dateien hineinziehen, *Commit*. Nach kurzer Zeit lädt die App die neue Fassung.

## Bedienung

Oben steht die **Menüleiste** mit allen Menüs des Roboters (0 Leerlauf bis 8 App-Fahren).
Antippen öffnet die Seite des Menüs und schaltet den Roboter dorthin. Der grüne Punkt
zeigt, in welchem Menü der Roboter wirklich ist; wechselt er selbst (Taste 4 am Roboter,
Stop), geht die App mit. **Stop** (oben rechts, Leertaste) hält immer sofort an.

1. Roboter einschalten, **Verbinden** → Roboter wählen. Ohne Roboter: **Demo**.
2. **Menü 0 Leerlauf** – Bluefruit-Tasten (wie die Bluefruit-App, inkl. langem Druck)
   und Infos: Firmware, Räder, Akkus.
3. **Menü 1 Fernsteuerung** – Steuerkreuz freigeben, Richtung antippen = fahren,
   nochmal = anhalten; Tempo wechseln.
4. **Menü 2 Muster**
   - *Gespeicherte Muster*: Vorschau antippen wählt das Muster im Roboter.
     *Starten / abbrechen*. Gezeichnet wird ab der Stelle, an der der Roboter steht.
   - *Bild hochladen*: JPG/PNG wählen, Verfahren einstellen (siehe unten), Ergebnis
     prüfen, *Bild zeichnen lassen*. Roboter mit dem Stift auf die Blattmitte, Blick
     nach rechts.
   - *Formen aus der App*: **Kreis**, **Quadrat**, **Dreieck**, **Stern**, **Pfeil** (Größe
     wählbar, füllbar; Pfeil nur mit parallelen Linien), **Prüfquadrat**, außerdem die
     Linienzüge **Ziege** (Größe in %), **Rechteckraster** (Länge x hoch/runter, Abstand y
     quer, Anzahl Bahnen – erst rechts herum, dann links herum, im Wechsel) und
     **Zickzack** (Zackenbreite, Zackenhöhe, Anzahl).
     *Füllung*: **parallele Linien** (Linienabstand, Standard 5 mm, und Winkel zur
     Grundlinie: 0° = parallel zur Unterkante) oder **Kontur nach innen** – eine Spirale,
     deren Windungen dem Umriss im Linienabstand nach innen folgen. *Umriss zeichnen*
     an/aus. Die Vorschau zeigt Leerfahrten gestrichelt; mehr als 1500 Punkte (sehr
     kleiner Abstand bei großen Formen) lassen sich nicht senden.
     **Start:** Der Roboter steht mit dem Stift am Startpunkt der Form – bei Vielecken an
     einer Ecke (beim Stern an einer Spitze), beim Kreis auf dem Rand – und schaut entlang
     der ersten Kante (grüner Punkt mit Pfeil in der Vorschau).
     **Wiederholen:** Haken bei „Wiederholen“ setzen, Winkel und Richtung wählen. Nach
     jeder fertigen Form dreht sich der Roboter am Startpunkt um diesen Winkel und
     zeichnet die Form noch einmal – so entstehen Rosetten. Anzahl 0 = so oft, bis ein
     voller Kreis erreicht ist (360 / Winkel). Der Kreis startet rechts außen und läuft links herum. Das Prüfquadrat
     fährt erst links herum (nur Linksdrehungen), dann dasselbe Quadrat rechts herum
     (nur Rechtsdrehungen): liegen beide genau übereinander, stimmen beide
     Drehrichtungen.
5. **Menü 3 Zufallsfahrt**, **Menü 4 Driftkorrektur**, **Menü 6 Hardwaretest** –
   die Funktionen als Knöpfe. Was fährt, fragt vorher nach.
6. **Menü 7 Kunst** – alle Algorithmen mit kleiner Vorschau. Antippen, Seed und Blatt
   wählen: die App stellt den Roboter genauso ein. *Seed vom Sensor* würfelt im
   Roboter mit dem Entfernungsmesser. *Zeichnen / abbrechen*.
7. **Menü 8 App-Fahren** – *Fahrbefehle* (Strecken in cm, Drehungen in Grad, Stift,
   Tempo; vorher *Fahren freigeben*) und *Zeichnen* (Freihand, Linienzug, Rechteck,
   Kreis, Vorlagen, Pfad-Vorschau mit Abspielen, *An Roboter senden*).
8. **Einstellungen** – Kalibrieren (Spurweite aus gemessenem Drehwinkel,
   Raddurchmesser aus gemessener Strecke), **Drehtest mit Linie** (siehe unten), **Stift einstellen** (Winkel für oben/unten, *Test oben/unten*)
   und Hell/Dunkel. Alle Werte gelten bis zum Neustart; die passenden Zeilen für
   `global.h` stehen jeweils darunter.

### Bild in Linien umwandeln

Die App verkleinert das Bild auf höchstens 360 Pixel, rechnet es in Graustufen um,
glättet es leicht und streckt den Kontrast. Dann gibt es drei Verfahren:

| Verfahren | Ergebnis | gut für |
|---|---|---|
| **Umriss** | Konturen der dunklen Flächen bei einer Schwelle (Startwert automatisch) | Logos, Silhouetten, Strichzeichnungen |
| **Höhenlinien** | Konturen bei 2–5 Helligkeitsstufen, wie auf einer Landkarte | Porträts, Fotos mit Verläufen |
| **Schraffur** | parallele Linien, je dunkler desto mehr Lagen (45°, −45°, 0°, 90°) | Fotos, Flächen; wenige lange Striche |

Danach: aufs Blatt einpassen (*Größe*), Linien vereinfachen (*Vereinfachen*: größer =
weniger Punkte), kurze Schnipsel weglassen (*Kürzeste Linie*), Reihenfolge so legen,
dass die Leerfahrten kurz werden. Der Roboter speichert höchstens 1500 Punkte – die
App warnt vorher. *Hell und dunkel tauschen* hilft bei hellen Motiven auf dunklem Grund.

### Korrekturen an / aus

Karte *Korrekturen an / aus* in den Einstellungen schaltet alle Korrekturfaktoren
gemeinsam (Drehfaktor links/rechts, Radfaktoren, Geradeaus-Ausgleich) – zum Vergleichen
„mit“ und „ohne“. Die Werte bleiben gespeichert. Raddurchmesser und Spurweite bleiben
immer aktiv. Gilt bis zum Neustart; dauerhaft über `CORRECTIONS_ENABLED` (1/0) in
`global.h`. Solange die Korrekturen AUS sind, sperrt die App das Übernehmen neuer
Faktoren (die Messung wäre sonst falsch).

### Einmessen in drei Schritten (Einstellungen)

Reihenfolge einhalten – jeder Schritt baut auf dem vorigen auf. Jede Testfahrt schaltet
den Roboter auf Menü 8, fragt nach der Freigabe und fährt langsam.

1. **Strecke korrigieren** – *Testfahrt zeichnen*: 10 cm mit Stift, danach 10 cm mit
   gehobenem Stift weiter, damit der Roboter aus dem Weg ist. Strichlänge messen,
   eintragen, *Raddurchmesser übernehmen*.
2. **Geradeauslauf** – *Testlinie zeichnen* (Standard 40 cm). Lineal an Anfang und Ende
   des Strichs anlegen, in der Mitte den Abstand Strich–Lineal messen und angeben, ob der
   Roboter eine Links- oder Rechtskurve gefahren ist (in Fahrtrichtung gesehen).
   *Ausgleich übernehmen*, Test wiederholen, bis die Linie gerade ist.
3. **Drehtest mit Linie** – siehe unten.

Bei „Nicht übernommen: …“ im Protokoll war der Roboter noch beschäftigt oder nicht
verbunden; die App hält ihn bei „busy“ automatisch an und versucht es noch einmal.

### Drehtest mit Linie (Links- und Rechtsdrehung abgleichen)

*Test rechts zeichnen*: Der Roboter zeichnet 20 cm vorwärts, dreht 360° rechts herum
und fährt mit Stift 20 cm zurück. Dann mit dem Lineal messen, wie weit die Rücklinie
neben der Hinlinie liegt – in Fahrtrichtung (vom Start zum Wendepunkt) gesehen –
und wähle daneben *rechts* oder *links*.

- *Abstand am Wendepunkt*: direkt nach der Drehung. Ist er nicht 0, ist der Roboter
  beim Drehen **verrutscht** – das ist Mechanik, kein Winkelfehler.
- *Abstand am Startpunkt*: Die App rechnet aus dem Unterschied zum Wendepunkt den
  echten Drehwinkel und den neuen Faktor. *Faktor übernehmen*, Test wiederholen, bis
  die Linien übereinander liegen. Dann den Wert in `global.h` eintragen.

Streuen die Werte von Versuch zu Versuch stark, rutscht etwas. Prüfen: Madenschrauben
der Räder fest auf der Motorwelle (ein Rad, das nur in einer Richtung durchrutscht,
macht genau einen Fehler in einer Drehrichtung), Gummi auf den Rädern und sauber,
Stützrad/-kugel leichtgängig, Stift nur aufliegend (Winkel *Unten* etwas höher),
glattes Fotopapier vermeiden.

## Wenn etwas nicht geht

- **Roboter erscheint nicht in der Liste:** Bluefruit-App noch verbunden? Bluetooth
  am PC/Handy an? Auf Android braucht Chrome die Berechtigung *Geräte in der Nähe*.
- **„Dieser Browser kann kein Bluetooth“:** anderen Browser nehmen (siehe Tabelle)
  oder die Seite wurde nicht über https geöffnet.
- **Fahrbefehle werden abgelehnt:** Statusleiste prüfen – Menü 8 und *Fahren: frei*
  müssen stehen. Ein Menüwechsel sperrt automatisch.
- **Menü 5 fehlt:** Absicht. Der Distanz-Monitor ist entfallen; dieselbe Messung gibt es
  im Hardwaretest (Menü 6).
- **Im Protokoll fehlen Zeilen:** Haken *Maschinenzeilen* zeigt auch die
  Statusmeldungen der Firmware (`@STAT`, `@PROG` …).
