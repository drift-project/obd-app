# DRIFThing OBD (aplikacja na telefon)

Strona WWW, która w Chrome łączy się z adapterem OBD2 ELM327 po Bluetooth, pokazuje dane z auta na żywo (obroty, prędkość, gaz, pedał, temperatury) i zapisuje je do CSV w tym samym formacie co logger na Raspberry (`obd_main.py` w repo `raspberry-unicore`).

To wersja na pierwszy test: bez instalacji, bez budowania, bez wysyłania danych na serwer.

## Wymagania

- Telefon z Androidem i Chrome 137 lub nowszym. Działa też Chrome albo Edge na laptopie.
- Adapter ELM327 z klasycznym Bluetooth, wcześniej **sparowany w ustawieniach Bluetooth systemu** (PIN zwykle `1234` albo `0000`). Adapter bierze zasilanie z gniazda OBD, więc parować trzeba go wpiętego w auto (dowolne).
- Do starszych aut (przed CAN, na przykład BMW E39) adapter musi obsługiwać linię K, czyli protokoły ISO 9141-2 i KWP2000. Część najtańszych klonów, zwłaszcza podpisanych "v2.1", obsługuje tylko CAN i z takim autem się nie połączy.
- iPhone nie zadziała: przeglądarki na iOS nie mają dostępu do portów szeregowych.

## Uruchomienie na laptopie

```bash
npm start
```

Otwórz `http://localhost:8093`. Przycisk **Demo** pokazuje aplikację na symulowanym aucie. **Connect adapter** otwiera listę portów (sparowany adapter jest na niej jako urządzenie Bluetooth albo port COM).

Demo ma trzy warianty, wybierane w adresie strony:

- `http://localhost:8093/` to auto z CAN, około 20 wierszy na sekundę,
- `http://localhost:8093/?car=kline` to stare auto z linią K (jak E39): jedna wartość na zapytanie, około 2 wierszy na sekundę,
- `http://localhost:8093/?car=silent` to auto, które nie odpowiada: widać komunikat na ekranie i kolejne próby w dzienniku.

## Uruchomienie na telefonie

Chrome udostępnia porty szeregowe tylko stronom z HTTPS albo z `localhost`. Bez publikowania strony najprościej przez USB:

1. Włącz w telefonie debugowanie USB i podłącz go do laptopa.
2. Na laptopie uruchom `npm start`, a w drugim terminalu:

   ```bash
   adb reverse tcp:8093 tcp:8093
   ```

3. W Chrome na telefonie otwórz `http://localhost:8093` i z menu wybierz "Dodaj do ekranu głównego".
4. Odłącz kabel, zamknij Chrome i otwórz aplikację z ikony. Jeśli się otwiera, w aucie też się otworzy.

Po pierwszym otwarciu aplikacja działa bez laptopa: pliki zostają w pamięci telefonu (service worker), więc w aucie wystarczy uruchomić ją z ikony. Numer wersji jest w stopce strony. Nową wersję telefon pobierze dopiero przy następnym otwarciu z podłączonym laptopem.

Zamiast tego można wrzucić folder na dowolny hosting statyczny z HTTPS. Wtedy wystarczy sam link, a poprawki docierają na telefon po odświeżeniu strony, także przy aucie.

## Test w aucie z samym telefonem

W domu, zanim pojedziesz:

1. Wgraj aplikację na telefon (rozdział wyżej) i sprawdź, że otwiera się bez laptopa.
2. Wepnij adapter w dowolne auto, włącz zapłon i sparuj adapter w ustawieniach Bluetooth telefonu.
3. Zrób próbę na tym aucie: **Connect adapter**, wybierz adapter z listy, poczekaj na dane. Przy pierwszym razie Chrome poprosi o zgodę na urządzenia w pobliżu. Jeśli to działa, telefon, przeglądarka i adapter są sprawdzone, a w aucie docelowym zostaje do sprawdzenia tylko ono samo.

Przy aucie:

1. Wepnij adapter (kontrolka ma świecić), włącz zapłon, najlepiej odpal silnik.
2. Otwórz aplikację i dotknij **Connect adapter**. Pod nagłówkiem widać, co się dzieje: reset adaptera, szukanie protokołu, kolejne próby. W starym aucie pierwsze połączenie może trwać kilkanaście sekund.
3. Gdy dane lecą, zapisują się same. Na koniec **Save CSV** albo **Share**.
4. Gdy coś nie działa, na górze pojawia się komunikat z przyczyną, a aplikacja próbuje dalej sama. Rozwiń **Diagnostic log** i wyślij go przyciskiem **Share** (albo **Copy** i wklej do wiadomości). W środku jest cała rozmowa z adapterem, wersja adaptera, napięcie i lista prób, więc da się z tego ustalić przyczynę bez laptopa przy aucie.

Dziennik diagnostyczny przetrwa zamknięcie strony, więc można go wysłać także po powrocie.

## Stare auta z linią K (na przykład BMW E39)

E39 nie ma CAN na gnieździe diagnostycznym. Według list zgodności skanerów benzynowe wersje rozmawiają protokołem ISO 9141-2, a 530d protokołem KWP2000 (fast init). Dla aplikacji oznacza to:

- **Wolniejszy odczyt.** Jedno zapytanie zwraca jedną wartość i trwa zwykle ponad 100 ms, więc trzy szybkie sygnały (obroty, prędkość, gaz) dają około 2 wierszy na sekundę. To szacunek z symulacji, prawdziwą liczbę pokaże pole "One request" w **Adapter details** i dziennik diagnostyczny.
- **Wartości w wierszu są czytane po kolei.** Znacznik czasu wiersza to środek cyklu, więc pierwsza wartość (obroty) jest starsza o mniej więcej jedno zapytanie, a ostatnia młodsza. Na CAN szybkie wartości zwykle przychodzą jednym zapytaniem i różnicy nie ma.
- **Szukanie protokołu z zapasem.** Aplikacja najpierw zleca adapterowi automatyczne szukanie, a gdy ono zawiedzie (zdarza się to na autach z ISO 9141-2), sama próbuje kolejno ISO 9141-2, KWP fast init i KWP z inicjalizacją 5 baud. Protokół, który zadziałał, jest zapamiętywany i przy następnym połączeniu idzie pierwszy.
- **Mniej sygnałów.** Auto zgłasza, co obsługuje. Pedał gazu (PID 49) i ciśnienie w kolektorze w takim aucie zwykle będą oznaczone "n/a".
- **Gniazdo.** Auta po liftingu (od około połowy 2000 roku) mają 16-pinowe gniazdo OBD w kabinie, pod kierownicą po stronie drzwi, za klapką. Starsze mają okrągłe gniazdo 20-pin pod maską i mogą wymagać przejściówki 20 na 16 pin.

Jeśli auto nie odpowiada na żadnym protokole przy włączonym zapłonie, zostają dwie przyczyny, których aplikacja nie obejdzie: adapter bez działającej linii K albo sterownik silnika bez standardowego OBD2 (wtedy dane da się czytać tylko protokołem BMW, kablem INPA).

## Użycie na co dzień

1. Wepnij adapter w gniazdo OBD2 i włącz zapłon.
2. Otwórz aplikację i dotknij **Connect adapter**, a potem wybierz adapter z listy. Następnym razem aplikacja połączy się z nim od razu. **Choose another adapter** wybiera inny.
3. Dane zapisują się same od chwili połączenia. **Save CSV** zapisuje plik `obd_data_RRRRMMDD_GGMMSS.csv` w pobranych, **Share** wysyła go dalej (Dysk, Messenger), **Clear** (dwa dotknięcia) kasuje log.

Log jest trzymany w pamięci przeglądarki, dopóki go nie skasujesz, więc przetrwa zamknięcie strony. Przy nagłym zamknięciu może przepaść około ostatniej sekundy.

Strona musi być na wierzchu, z włączonym ekranem (aplikacja sama blokuje wygaszanie). W tle Chrome wstrzymuje strony i zapis staje.

## Dane

Kolumny CSV: `timestamp_ms, rpm, speed_kmh, throttle_pct, pedal_pct, engine_load_pct, coolant_c, intake_air_c, maf_gs, map_kpa`. Pusta komórka oznacza, że auto nie obsługuje danej wartości albo nie była czytana w tym cyklu (wartości silnika są czytane kolejno, jedna na sekundę).

`timestamp_ms` to zegar telefonu w środku zapytania. Telefon synchronizuje zegar z siecią, więc dane da się zestawić z GNSS z urządzenia.

Aplikacja pyta auto, które wartości obsługuje, i czyta tylko te. Listy zgłoszone przez różne sterowniki (silnik, skrzynia) są łączone. Na CAN szybkie dane idą jednym zapytaniem, o ile auto na to pozwala; na linii K zawsze po jednej wartości.

## Czego jeszcze nie ma

- Nie było testu z prawdziwym adapterem i autem ani na prawdziwym telefonie. Sprawdzone jest wszystko do granicy Bluetooth: protokół na symulatorze (CAN i linia K), ekran, zapis, ponowne łączenie, dziennik diagnostyczny i praca bez serwera.
- Dane nie są nigdzie wysyłane. Żeby trafiały do projektu, trzeba je dopiąć do brokera MQTT (przeglądarka potrzebuje do tego MQTT po WebSocket) albo wgrywać CSV.
- Hamulec i kąt skrętu kierownicy nie są standardowymi wartościami OBD2. Wymagają czytania surowych ramek konkretnego modelu auta, a w E39 protokołu BMW.

## Testy

```bash
npm test
```

Testy (Node 22, bez zależności) sprawdzają dekodowanie wartości, parsowanie odpowiedzi adaptera, sesję na symulatorze (CAN, linia K, klon odrzucający komendy, auto bez odpowiedzi, zawieszone szukanie protokołu), pętlę odczytu z ponownym łączeniem, dziennik diagnostyczny, transport Web Serial na podstawionym porcie, eksport CSV i listę plików do pracy bez serwera.

## Pliki

- `src/pids.js`, `src/elm327.js`, `src/poller.js`: protokół i pętla odczytu (przeniesione z loggera na Raspberry).
- `src/transports.js`: połączenie przez Web Serial. `src/simulator.js`: symulowany adapter i auto.
- `src/trace.js`: dziennik diagnostyczny rozmowy z adapterem.
- `src/app.js`, `index.html`, `styles.css`: ekran. `src/storage.js`, `src/csv.js`: log i eksport.
- `sw.js`, `manifest.webmanifest`: praca bez serwera i ikona na ekranie głównym. Nowy plik aplikacji trzeba dopisać do listy w `sw.js` (pilnuje tego test).
- `tools/make_icons.py`: generuje ikony PNG (wymaga Pillow).
