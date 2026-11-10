# DRIFThing OBD (aplikacja na telefon)

Strona WWW, która w Chrome łączy się z adapterem OBD2 ELM327 po Bluetooth, pokazuje dane z auta na żywo (obroty, prędkość, gaz, pedał, temperatury) i zapisuje je do CSV w tym samym formacie co logger na Raspberry (`obd_main.py` w repo `raspberry-unicore`).

To wersja na pierwszy test: bez instalacji, bez budowania, bez wysyłania danych na serwer.

## Wymagania

- Telefon z Androidem i Chrome 137 lub nowszym. Działa też Chrome albo Edge na laptopie.
- Adapter ELM327 z klasycznym Bluetooth, wcześniej **sparowany w ustawieniach Bluetooth systemu** (PIN zwykle `1234` albo `0000`).
- iPhone nie zadziała: przeglądarki na iOS nie mają dostępu do portów szeregowych.

## Uruchomienie na laptopie

```bash
npm start
```

Otwórz `http://localhost:8093`. Przycisk **Demo** pokazuje aplikację na symulowanym aucie. **Connect adapter** otwiera listę portów (sparowany adapter jest na niej jako urządzenie Bluetooth albo port COM).

## Uruchomienie na telefonie

Chrome udostępnia porty szeregowe tylko stronom z HTTPS albo z `localhost`. Bez publikowania strony najprościej przez USB:

1. Włącz w telefonie debugowanie USB i podłącz go do laptopa.
2. Na laptopie uruchom `npm start`, a w drugim terminalu:

   ```bash
   adb reverse tcp:8093 tcp:8093
   ```

3. W Chrome na telefonie otwórz `http://localhost:8093` i z menu wybierz "Dodaj do ekranu głównego".

Po pierwszym otwarciu aplikacja działa bez laptopa: pliki zostają w pamięci telefonu (service worker), więc w aucie wystarczy uruchomić ją z ikony. Nową wersję telefon pobierze przy następnym otwarciu z podłączonym laptopem.

Zamiast tego można wrzucić folder na dowolny hosting statyczny z HTTPS. Wtedy wystarczy sam link.

## Użycie w aucie

1. Wepnij adapter w gniazdo OBD2 i włącz zapłon.
2. Otwórz aplikację i dotknij **Connect adapter**, a potem wybierz adapter z listy. Następnym razem aplikacja połączy się z nim od razu. **Choose another adapter** wybiera inny.
3. Dane zapisują się same od chwili połączenia. **Save CSV** zapisuje plik `obd_data_RRRRMMDD_GGMMSS.csv` w pobranych, **Share** wysyła go dalej (Dysk, Messenger), **Clear** (dwa dotknięcia) kasuje log.

Log jest trzymany w pamięci przeglądarki, dopóki go nie skasujesz, więc przetrwa zamknięcie strony. Przy nagłym zamknięciu może przepaść około ostatniej sekundy.

Strona musi być na wierzchu, z włączonym ekranem (aplikacja sama blokuje wygaszanie). W tle Chrome wstrzymuje strony i zapis staje.

## Dane

Kolumny CSV: `timestamp_ms, rpm, speed_kmh, throttle_pct, pedal_pct, engine_load_pct, coolant_c, intake_air_c, maf_gs, map_kpa`. Pusta komórka oznacza, że auto nie obsługuje danej wartości albo nie była czytana w tym cyklu (wartości silnika są czytane kolejno, jedna na sekundę).

`timestamp_ms` to zegar telefonu w środku zapytania. Telefon synchronizuje zegar z siecią, więc dane da się zestawić z GNSS z urządzenia.

Aplikacja pyta auto, które wartości obsługuje, i czyta tylko te. Jeśli auto odpowiada na kilka wartości w jednym zapytaniu, szybkie dane idą jednym zapytaniem. Symulator z opóźnieniem 40 ms daje około 20 wierszy na sekundę; tani adapter da zwykle od kilku do kilkunastu.

## Czego jeszcze nie ma

- Nie było testu z prawdziwym adapterem i autem. Sprawdzone jest wszystko do granicy Bluetooth: protokół na symulatorze, ekran, zapis, ponowne łączenie i praca bez serwera.
- Dane nie są nigdzie wysyłane. Żeby trafiały do projektu, trzeba je dopiąć do brokera MQTT (przeglądarka potrzebuje do tego MQTT po WebSocket) albo wgrywać CSV.
- Hamulec i kąt skrętu kierownicy nie są standardowymi wartościami OBD2. Wymagają czytania surowych ramek CAN konkretnego modelu auta.

## Testy

```bash
npm test
```

Testy (Node 22, bez zależności) sprawdzają dekodowanie wartości, parsowanie odpowiedzi adaptera, sesję na symulatorze, pętlę odczytu z ponownym łączeniem, transport Web Serial na podstawionym porcie i eksport CSV.

## Pliki

- `src/pids.js`, `src/elm327.js`, `src/poller.js`: protokół i pętla odczytu (przeniesione z loggera na Raspberry).
- `src/transports.js`: połączenie przez Web Serial. `src/simulator.js`: symulowany adapter i auto.
- `src/app.js`, `index.html`, `styles.css`: ekran. `src/storage.js`, `src/csv.js`: log i eksport.
- `sw.js`, `manifest.webmanifest`: praca bez serwera i ikona na ekranie głównym.
- `tools/make_icons.py`: generuje ikony PNG (wymaga Pillow).
