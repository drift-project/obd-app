# DRIFThing OBD (aplikacja na telefon)

Strona WWW, która w Chrome łączy się z adapterem OBD2 ELM327 po Bluetooth, pokazuje dane z auta na żywo (obroty, prędkość, gaz, pedał, temperatury) i zapisuje je do CSV w tym samym formacie co logger na Raspberry (`obd_main.py` w repo `raspberry-unicore`). Razem z danymi auta zapisuje czujniki telefonu: akcelerometr, żyroskop, magnetometr, orientację i GPS. Zapisany przejazd da się odtworzyć w aplikacji: auto na mapie, wykresy dowolnych sygnałów, tempo od ×0,25 do ×16.

To wersja na pierwszy test: bez instalacji, bez budowania, bez wysyłania danych na serwer.

## Wymagania

- Telefon z Androidem i Chrome 137 lub nowszym. Działa też Chrome albo Edge na laptopie.
- Adapter ELM327 z klasycznym Bluetooth, wcześniej **sparowany w ustawieniach Bluetooth systemu** (PIN zwykle `1234` albo `0000`). Adapter bierze zasilanie z gniazda OBD, więc parować trzeba go wpiętego w auto (dowolne).
- Do starszych aut (przed CAN, na przykład BMW E39) adapter musi obsługiwać linię K, czyli protokoły ISO 9141-2 i KWP2000. Część najtańszych klonów, zwłaszcza podpisanych "v2.1", obsługuje tylko CAN i z takim autem się nie połączy.
- iPhone nie zadziała: przeglądarki na iOS nie mają dostępu do portów szeregowych.

## Adres

Aplikacja jest opublikowana na GitHub Pages z gałęzi `main` tego repo:

**https://drift-project.github.io/obd-app/**

Zmiana wypchnięta na `main` jest pod tym adresem zwykle po około minucie.

## Uruchomienie na telefonie

1. Otwórz adres w Chrome na telefonie.
2. Z menu Chrome wybierz "Dodaj do ekranu głównego".
3. Zamknij Chrome i otwórz aplikację z ikony.

Po pierwszym otwarciu aplikacja działa także bez internetu: pliki zostają w pamięci telefonu (service worker), więc w aucie wystarczy uruchomić ją z ikony.

**Aktualizacje.** Aplikacja zawsze uruchamia się z plików zapisanych w telefonie, wszystkich z jednej wersji (numer wersji jest w stopce strony). Przy każdym otwarciu z internetem Chrome sprawdza, czy na serwerze jest nowsza wersja. Jeśli jest, pobiera ją w tle w całości; do tego czasu działa dotychczasowa, a przełączenie następuje dopiero, gdy otwarta strona załadowała już wszystkie swoje pliki. Przerwane albo bardzo wolne pobieranie (słaby zasięg) niczego nie psuje: strona nigdy nie dostaje części plików z jednej wersji, a części z drugiej, a pobieranie ponowi się przy następnym otwarciu. Gdy nowa wersja jest gotowa:

- strona, której jeszcze nie dotknięto, przełącza się na nią i przeładowuje sama (zwykle kilka sekund po otwarciu),
- strona, której już używasz, pokazuje na górze pasek "A new version of the app is ready." z przyciskiem **Reload**,
- w trakcie zapisu przejazdu (także Demo) strona nigdy nie przeładowuje się sama; pasek prosi o przeładowanie po jeździe, a przycisk pojawia się po zatrzymaniu zapisu. Log z auta i czujników jest zapisany w telefonie (chyba że w sekcji Log widnieje "Memory only"), więc przeładowanie go nie kasuje.

Pobrana wersja, na którą strona się nie przełączyła, włącza się sama przy następnym uruchomieniu po zamknięciu aplikacji (na liście ostatnich aplikacji). Tak samo trzeba raz zamknąć i otworzyć aplikację przy przejściu z wersji 0.9.2 lub starszej, które jeszcze tego nie umiały; potem działa już powyższy sposób.

### Lista adapterów jest pusta

Jeśli po dotknięciu **Connect adapter** Chrome pisze "Nie znaleziono zgodnych urządzeń", a adapter jest sparowany i działa w innej aplikacji (na przykład Car Scanner), to Chrome nie ma dostępu do Bluetooth:

1. Ustawienia telefonu, Aplikacje, Chrome, Uprawnienia: ustaw **Urządzenia w pobliżu** na "Zezwól".
2. Na ekranie aplikacji Chrome dotknij **Wymuś zatrzymanie**. Chrome układa listę urządzeń Bluetooth raz na uruchomienie, więc bez tego lista zostaje pusta.
3. Rozłącz inną aplikację OBD (adapter obsługuje jedno połączenie naraz), otwórz DRIFThing OBD i spróbuj ponownie.

Od wersji 0.2.2 aplikacja prosi na Androidzie tylko o porty Bluetooth i wtedy Chrome sam pyta o to uprawnienie. Chrome pokazuje wyłącznie urządzenia sparowane w ustawieniach Bluetooth telefonu, dla których system zapamiętał usługę portu szeregowego.

## Uruchomienie na laptopie

Ten sam adres działa w Chrome i Edge na laptopie. Do pracy nad kodem aplikację uruchamia się lokalnie:

```bash
npm start
```

Otwórz `http://localhost:8093`. Przycisk **Demo** pokazuje aplikację na symulowanym aucie. **Connect adapter** otwiera listę portów (sparowany adapter jest na niej jako urządzenie Bluetooth albo port COM).

Demo ma trzy warianty, wybierane dopiskiem w adresie strony (lokalnie i pod adresem publicznym):

- bez dopisku: auto z CAN, około 20 wierszy na sekundę,
- `?car=kline`: stare auto z linią K (jak E39), jedna wartość na zapytanie, około 7 wierszy na sekundę (każda wartość w osobnym wierszu),
- `?car=silent`: auto, które nie odpowiada; widać komunikat na ekranie i kolejne próby w dzienniku.

### Lokalna wersja na telefonie

Zmiany, których nie ma jeszcze na `main`, da się sprawdzić na telefonie przez USB. Chrome udostępnia porty szeregowe tylko stronom z HTTPS albo z `localhost`, więc telefon musi widzieć lokalny serwer jako swój `localhost`:

1. Włącz w telefonie debugowanie USB i podłącz go do laptopa.
2. Na laptopie uruchom `npm start`, a w drugim terminalu:

   ```bash
   adb reverse tcp:8093 tcp:8093
   ```

3. W Chrome na telefonie otwórz `http://localhost:8093`.

## Test w aucie z samym telefonem

W domu, zanim pojedziesz:

1. Otwórz aplikację na telefonie i dodaj ją do ekranu głównego (rozdział wyżej). Sprawdź, że otwiera się z ikony także w trybie samolotowym.
2. Wepnij adapter w dowolne auto, włącz zapłon i sparuj adapter w ustawieniach Bluetooth telefonu.
3. Zrób próbę na tym aucie: **Connect adapter**, wybierz adapter z listy, poczekaj na dane. Przy pierwszym razie Chrome poprosi o zgodę na urządzenia w pobliżu. Jeśli to działa, telefon, przeglądarka i adapter są sprawdzone, a w aucie docelowym zostaje do sprawdzenia tylko ono samo.

Przy aucie:

1. Wepnij adapter (kontrolka ma świecić), włącz zapłon, najlepiej odpal silnik.
2. Otwórz aplikację i dotknij **Connect adapter**. Pod nagłówkiem widać, co się dzieje: reset adaptera, szukanie protokołu, kolejne próby. W starym aucie pierwsze połączenie może trwać kilkanaście sekund.
3. Gdy dane lecą, zapisują się same. Na koniec **Save** albo **Share**.
4. Gdy coś nie działa, na górze pojawia się komunikat z przyczyną, a aplikacja próbuje dalej sama. Rozwiń **Diagnostic log** i wyślij go przyciskiem **Share** (albo **Copy** i wklej do wiadomości). W środku jest cała rozmowa z adapterem, wersja adaptera, napięcie i lista prób, więc da się z tego ustalić przyczynę bez laptopa przy aucie.

Dziennik diagnostyczny przetrwa zamknięcie strony, więc można go wysłać także po powrocie.

## Stare auta z linią K (na przykład BMW E39)

E39 nie ma CAN na gnieździe diagnostycznym. Według list zgodności skanerów benzynowe wersje rozmawiają protokołem ISO 9141-2, a 530d protokołem KWP2000 (fast init). Dla aplikacji oznacza to:

- **Wolniejszy odczyt.** Jedno zapytanie zwraca jedną wartość. W teście na E39 (10.11.2026) trwało około 240 ms, czyli auto daje około 4 wartości na sekundę: obroty, prędkość i gaz po około 1,2 Hz, a temperatury co około 6 s. To granica protokołu ISO 9141-2, nie aplikacji. Czas zapytania pokazuje pole "One request" w **Adapter details**.
- **Tryb odczytu „For drifting”.** Cztery odczyty na sekundę to mało, więc przełącznik **Read from the car** pod przyciskami połączenia pozwala wydać je na to, po czym ocenia się drift: prędkość kół dwa razy na cykl, gaz i obroty po razie (kolejność: koła, gaz, koła, obroty), a z wolnych wartości tylko temperatura płynu co 10 sekund i napięcie co 10 sekund. Koła są wtedy czytane około 2 razy na sekundę zamiast 1,2. Obciążenie, powietrze zasysane i przepływ powietrza w tym trybie nie są czytane. Gdy auto podaje pedał gazu, czytany jest pedał zamiast przepustnicy. Na CAN szybkie wartości i tak idą jednym zapytaniem, więc tryb tylko pomija wolne. Domyślnie jest „Everything the car has”, czyli jak dotąd; wybór zostaje w telefonie i można go zmienić w trakcie połączenia.
- **Każda wartość ma własny wiersz i własny czas.** Od wersji 0.6.0 wartość odczytana jednym zapytaniem trafia do osobnego wiersza ze znacznikiem czasu ze środka tego zapytania, a pozostałe komórki wiersza są puste. Wcześniej cały cykl (około sekundy) był jednym wierszem ze wspólnym czasem, więc wartości były przesunięte względem siebie nawet o 0,4 s. Liczba przy "Connected" i licznik wierszy liczą teraz wiersze, czyli na linii K pojedyncze wartości (około 4 na sekundę). Na CAN szybkie wartości przychodzą jednym zapytaniem i wiersz dalej jest całym cyklem.
- **Szukanie protokołu z zapasem.** Aplikacja najpierw zleca adapterowi automatyczne szukanie, a gdy ono zawiedzie (zdarza się to na autach z ISO 9141-2), sama próbuje kolejno ISO 9141-2, KWP fast init i KWP z inicjalizacją 5 baud. Protokół, który zadziałał, jest zapamiętywany i przy następnym połączeniu idzie pierwszy.
- **Mniej sygnałów.** Auto zgłasza, co obsługuje. Pedał gazu (PID 49) i ciśnienie w kolektorze w takim aucie zwykle będą oznaczone "n/a".
- **Gniazdo.** Auta po liftingu (od około połowy 2000 roku) mają 16-pinowe gniazdo OBD w kabinie, pod kierownicą po stronie drzwi, za klapką. Starsze mają okrągłe gniazdo 20-pin pod maską i mogą wymagać przejściówki 20 na 16 pin.

Jeśli auto nie odpowiada na żadnym protokole przy włączonym zapłonie, zostają dwie przyczyny, których aplikacja nie obejdzie: adapter bez działającej linii K albo sterownik silnika bez standardowego OBD2 (wtedy dane da się czytać tylko protokołem BMW, kablem INPA).

## Użycie na co dzień

1. Wepnij adapter w gniazdo OBD2 i włącz zapłon.
2. Otwórz aplikację i dotknij **Connect adapter**, a potem wybierz adapter z listy. Następnym razem aplikacja połączy się z nim od razu. **Choose another adapter** wybiera inny.
3. Dane zapisują się same od chwili połączenia, razem z czujnikami telefonu. **Save** zapisuje log w pobranych: sam plik `obd_data_RRRRMMDD_GGMMSS.csv`, a gdy są dane z telefonu, archiwum `drifthing_log_RRRRMMDD_GGMMSS.zip` ze wszystkimi plikami. **Share** wysyła pliki CSV dalej (Dysk, Messenger), **Clear** (dwa dotknięcia) kasuje log.

Log jest trzymany w pamięci przeglądarki, dopóki go nie skasujesz, więc przetrwa zamknięcie strony. Przy nagłym zamknięciu może przepaść około ostatniej sekundy.

Strona musi być na wierzchu, z włączonym ekranem (aplikacja sama blokuje wygaszanie). W tle Chrome wstrzymuje strony i zapis staje.

## Alarm temperatury

W sekcji **Alarm** ustawia się temperaturę płynu chłodniczego (domyślnie 110 °C, 0 wyłącza). Gdy auto poda tyle albo więcej, na górze ekranu pojawia się czerwony pulsujący pasek z temperaturą, a telefon piszczy i wibruje co 8 sekund, aż płyn ostygnie o 3 stopnie poniżej progu. Dźwięk można wyłączyć. W trybie odczytu "For drifting" temperatura przychodzi co 10 sekund, w zwykłym co kilka sekund. Alarm działa tylko przy otwartej stronie i włączonym ekranie; jego początek i koniec trafiają do dziennika diagnostycznego. Sprawdzony na symulowanym aucie, dźwięku na telefonie jeszcze nie słyszałem.

## Moc silnika

Kafelek **Power** (tam, gdzie auto podaje przepływ powietrza) i sygnał `power_hp` w Replay to moc szacowana z przepływu powietrza: 1,2 KM na każdy gram powietrza na sekundę. Wynika to z proporcji 14,7 g powietrza na gram benzyny, 44 kJ w gramie benzyny i około 30% sprawności; tak samo liczy to Car Scanner ("Power from MAF"). To szacunek z dokładnością do mniej więcej jednej piątej, bez sensu dla diesla. W trybie odczytu "For drifting" przepływ nie jest czytany, więc mocy wtedy nie ma.

## Akumulator

Adapter mierzy napięcie na gnieździe diagnostycznym, czyli napięcie akumulatora. Aplikacja zapisuje je w kolumnie `battery_v` (przy zgaszonym silniku w każdym wierszu, przy pracującym co 5 sekund) i w sekcji **Battery** pokazuje:

- **Charge**: szacunek naładowania w procentach i w amperogodzinach, liczony z napięcia przy zgaszonym silniku.
- **Engine off**: napięcie przed uruchomieniem silnika.
- **While starting**: najniższe napięcie złapane podczas kręcenia rozrusznikiem. Odczyt jest mniej więcej raz na sekundę, więc najgłębszy spadek może umknąć.
- **Engine running**: napięcie ładowania z oceną. 13,6 do 14,9 V to normalne ładowanie, 13,0 do 13,6 V słabe, poniżej 13,0 V alternator nie ładuje, powyżej 14,9 V regulator podaje za dużo.

Żeby zobaczyć naładowanie, połącz adapter przy włączonym zapłonie, zanim odpalisz silnik, najlepiej po kilku godzinach postoju. Aplikacja zapamiętuje napięcie sprzed pierwszego rozruchu i nie zastępuje go późniejszymi odczytami, bo po jeździe akumulator pokazuje zawyżone napięcie. Gdy silnik już pracuje w chwili połączenia, naładowania nie da się ocenić.

| Naładowanie | Zwykły akumulator | AGM |
|---|---|---|
| 100% | 12,60 V | 12,84 V |
| 75% | 12,40 V | 12,54 V |
| 50% | 12,20 V | 12,24 V |
| 25% | 12,00 V | 11,94 V |
| 0% | 11,80 V | 11,64 V |

Wartości dla zwykłego akumulatora pochodzą z Battery Council International, dla AGM z danych firmy Trojan. Między wierszami aplikacja liczy proporcjonalnie.

To szacunek, nie pomiar:

- Jedna dziesiąta wolta to około 12% naładowania, a woltomierz taniego adaptera potrafi się mylić o jedną albo dwie dziesiąte. Warto raz porównać wskazanie z multimetrem na klemach i wpisać różnicę w polu **Voltmeter correction**.
- Włączony zapłon obciąża akumulator, więc napięcie jest nieco niższe niż na prawdziwym postoju.
- Akumulator ładowany w ostatnich godzinach pokazuje więcej, niż ma. Wiarygodny odczyt wymaga co najmniej 4 godzin postoju.
- Napięcie nie mówi nic o zużyciu akumulatora: stary może pokazywać 100% i mieć ułamek pojemności. Trochę mówi o tym spadek napięcia przy rozruchu.

Pojemność (domyślnie 100 Ah) i typ akumulatora ustawia się w tej samej sekcji; ustawienia zostają w telefonie.

## Czujniki telefonu

Razem z danymi auta aplikacja zapisuje czujniki telefonu. Zapis startuje sam po **Connect adapter**. Bez adaptera uruchamia go **Record the phone sensors without the car**. W trybie Demo czujniki nie są zapisywane.

| Plik | Co zawiera | Częstotliwość |
|---|---|---|
| `phone_accelerometer` | przyspieszenie z grawitacją, m/s² | 60 Hz |
| `phone_linear_acceleration` | przyspieszenie bez grawitacji, m/s² | 60 Hz |
| `phone_gyroscope` | prędkość obrotu, rad/s | 60 Hz |
| `phone_magnetometer` | pole magnetyczne, µT | 10 Hz |
| `phone_orientation` | ustawienie telefonu względem Ziemi (z kompasem), kwaternion | 60 Hz |
| `phone_relative_orientation` | ustawienie telefonu bez kompasu, kwaternion | 60 Hz |
| `phone_gps` | pozycja, wysokość, dokładność, kurs i prędkość | zwykle 1 Hz |
| `phone_drift` | to, co pokazywał widok Drift: kierunek nadwozia, kurs, kąt driftu | 10 Hz |

- **Częstotliwość.** 60 Hz dla czujników ruchu i 10 Hz dla magnetometru to granice Chrome dla stron WWW, nie samych czujników. Więcej da tylko aplikacja natywna.
- **Magnetometr** jest w Chrome wyłączony i zwykle nie warto go włączać: kompas i tak jest użyty w `phone_orientation`. Jak go włączyć, opisuje rozdział niżej.
- **GPS** wymaga zgody na lokalizację przy pierwszym uruchomieniu i włączonej lokalizacji w telefonie.
- **Dwie prędkości.** Na ekranie obok prędkości z auta (koła) jest prędkość z GPS (względem ziemi). Różnica między nimi to poślizg kół.
- **Osie** są osiami telefonu: x w prawo ekranu, y w górę ekranu, z od ekranu w stronę patrzącego. Telefon musi być sztywno zamocowany, inaczej dane ruchu opisują telefon, a nie auto.
- **Czas.** Każdy plik ma w pierwszej kolumnie `timestamp_ms` z jednego zegara: zegar telefonu jest odczytywany raz na starcie zapisu, a dalej liczy zegar monotoniczny, więc dane auta i telefonu da się zestawić. Czujniki ruchu dostają czas pomiaru podany przez czujnik, przeliczony na ten sam zegar. `phone_gps` ma w `timestamp_ms` chwilę, w której pozycja dotarła do aplikacji (zwykle kilkaset milisekund po pomiarze), a dodatkowo `fix_ms`, czyli czas pomiaru podany przez odbiornik. Opóźnienie GPS, które widok Drift wyznaczył z danych, jest w `phone_drift` w kolumnie `gps_delay_ms`.
- **Po uśpieniu telefonu.** Zegar monotoniczny może stać, gdy telefon śpi, więc zapis po przerwie miałby czas cofnięty o długość uśpienia. Od wersji 0.6.0 po powrocie strony na wierzch zegar zapisu jest przestawiany do przodu na zegar telefonu (nigdy do tyłu), a dziennik diagnostyczny notuje, o ile.

Stan każdego czujnika (częstotliwość, liczba próbek albo powód braku) pokazuje sekcja **Phone sensors**. Do loga dołączany jest plik `log_info` z opisem plików i kolumn. Od wersji 0.6.2 jest w nim też lista sesji nagrania: kiedy trwała każda, która wersja aplikacji ją nagrała, w jakim trybie czytane było auto, jaki adapter i protokół, i z którego czujnika orientacji brał się kierunek nadwozia. Log zostaje w telefonie przy aktualizacji aplikacji, więc jeden plik może mieć przejazdy z kilku wersji; pierwsza linia `log_info` podaje tylko wersję, która plik zapisała. Na końcu `log_info` jest pełny raport diagnostyczny (to samo, co **Diagnostic log**), więc jeden ZIP wystarcza do oceny przejazdu.

### Magnetometr

Surowy magnetometr Chrome trzyma za funkcją `GenericSensorExtraClasses`, która jest domyślnie wyłączona. Do około wersji 130 miała przełącznik `chrome://flags/#enable-generic-sensor-extra-classes`; w nowszych wersjach (sprawdzone w źródłach 140, 150 i 156) tego przełącznika już nie ma i zostaje wiersz poleceń ustawiany z komputera:

1. W Chrome na telefonie otwórz `chrome://flags/#enable-command-line-on-non-rooted-devices`, wybierz "Enabled" i uruchom Chrome ponownie.
2. Podłącz telefon kablem (debugowanie USB włączone) i na komputerze wykonaj:

   ```bash
   adb shell "echo '_ --enable-features=GenericSensorExtraClasses' > /data/local/tmp/chrome-command-line"
   ```

3. W ustawieniach telefonu wymuś zatrzymanie Chrome i otwórz aplikację ponownie. W sekcji **Phone sensors** przy magnetometrze powinno pojawić się "10 Hz".

Żeby to cofnąć, usuń plik: `adb shell rm /data/local/tmp/chrome-command-line`. Ta procedura wynika ze źródeł Chrome i nie była sprawdzana na telefonie. Sama flaga `enable-experimental-web-platform-features` nie wystarcza: pokazuje stronie klasę `Magnetometer`, ale czujnik dalej nie startuje.

## Widok Drift

Przełącznik **Car / Drift / Replay** pod nagłówkiem ma trzy zakładki. **Drift** zmienia licznik na mapę, wzorowaną na trybie analizy w `drifthing-ui`: ślad przejazdu, auto obrócone tak, jak stoi nadwozie, strzałka kierunku jazdy i odczyty na żywo.

- **Drift angle**: kąt między kierunkiem nadwozia a kierunkiem jazdy, liczony jak w `middle-math` (kierunek nadwozia minus kurs, od -180 do 180 stopni). Litera obok mówi, w którą stronę od kierunku jazdy wskazuje nos: **R** w prawo, **L** w lewo.
- **GPS** i **Car**: prędkość względem ziemi i prędkość kół z auta.
- **Turn**: prędkość obrotu auta w stopniach na sekundę, dodatnia w prawo.

Skąd bierze się kąt:

- **Kierunek nadwozia** pochodzi z orientacji telefonu liczonej bez kompasu (żyroskop i akcelerometr, plik `phone_relative_orientation`). Orientacja z kompasem jest używana tylko do chwili, gdy ta pierwsza zacznie przychodzić, albo w telefonie, który jej nie ma: w aucie kompas zakłócają stal nadwozia i prądy. Do wersji 0.6.0 aplikacja zostawała przy czujniku, który odezwał się pierwszy, i na pierwszej prawdziwej jeździe trafiła na kompas, przez co kierunek pływał o kilkadziesiąt stopni (poprawione w 0.6.1). Telefon wie tylko, o ile się obrócił, więc punkt odniesienia bierze z GPS: gdy auto jedzie prosto przez dwie sekundy z prędkością powyżej około 20 km/h, kierunek nadwozia jest ustawiany na kurs z GPS. Ta kalibracja powtarza się sama na każdej prostej i usuwa pełzanie żyroskopu. Mocowanie telefonu może być dowolne, byle sztywne.
- **Ruszony telefon.** Telefon wzięty do ręki albo przesunięty w uchwycie przestaje obracać się razem z autem i kierunek z niego jest bezwartościowy. Widać to w żyroskopie jako przechylanie (obrót wokół osi poziomych), którego auto prawie nie robi: w dotychczasowych jazdach najwyżej kilkanaście stopni w poślizgach i na nierównościach, a 25 do 120 stopni za każdym razem, gdy telefon był w ręce. Powyżej 20 stopni kierunek nadwozia jest kasowany do następnej prostej, a widok pisze "The phone was moved". Gdzie jest góra, aplikacja uczy się z akcelerometru, gdy auto stoi albo jedzie równo.
- **Uślizg kół na kafelku Car.** Gdy koła kręcą się szybciej, niż auto jedzie, kafelek robi się czerwony i pokazuje, o ile (na przykład "wheels +82%"); gdy wolniej, niebieski. Liczone jak w rozdziale "Koła a GPS", tylko bez patrzenia w przyszłość: skala auto/GPS jest brana z poprzedniej jazdy i poprawiana na równych odcinkach, a pojedynczy niewielki odczyt czeka na potwierdzenie następnym.
- **Poślizg na wprost** nie jest brany za jazdę prosto: duża poprawka krótko po poprzedniej jest odrzucana, a gdy auto podaje prędkość kół, kalibracja czeka, aż zgodzi się ona z prędkością z GPS.
- **Kierunek jazdy** podaje GPS, ale tylko raz na sekundę. Między pomiarami prędkość auta jest prowadzona dalej z akcelerometru. Ustawienie osi telefonu względem północy i opóźnienie pomiarów GPS aplikacja wyznacza sama z danych, po kilku zmianach prędkości albo kierunku. Do tego czasu kurs między pomiarami jest zgadywany i w ciasnych manewrach kąt może być chwilowo błędny o kilkanaście stopni. "Przyspieszenie bez grawitacji" podawane przez Androida pokazywało na prawdziwych jazdach tylko 20 do 70% rzeczywistej zmiany prędkości, bo telefon bierze długie przyspieszenie auta za zmianę kierunku grawitacji. Od wersji 0.8.1 aplikacja odejmuje grawitację sama: uczy się jej z surowego akcelerometru tylko wtedy, gdy GPS pokazuje postój albo równą jazdę na wprost, i wtedy akcelerometr zgadza się ze zmianami prędkości z GPS w 81 do 96% (zamiast 52 do 73%). Na czterech zapisanych przejazdach wspomaganie działa teraz przez 56 do 85% czasu (wcześniej 0 do 53%), a kierunek jazdy przewidziany na sekundę naprzód myli się w zakrętach o 1,8 do 5,4 stopnia (mediana; wcześniej 5,3 do 10,2). Przyspieszenie Androida jest używane tylko do chwili, aż aplikacja nauczy się grawitacji.
- **Ślad** ma dzięki temu punkty także między pomiarami GPS, więc łuki są gładkie.

W symulacji z idealnymi czujnikami błąd kąta jest poniżej stopnia, z zaszumionymi średnio 1,5 stopnia i chwilowo do kilku stopni. Na prawdziwym aucie jest jeden pomiar: 7 minut zwykłej jazdy po mieście 10.11.2026 (BMW E39, telefon w uchwycie), bez poślizgów, więc kąt powinien być bliski zera. Algorytm z wersji 0.6.1, puszczony na zapisanych czujnikach z tej jazdy, pokazuje powyżej 18 km/h medianę 0,3 stopnia i 1 stopień lub mniej przez 90% czasu. Dwa razy, przy wyjeździe ze skrzyżowania z przyspieszaniem, kąt skoczył do 11 i 22 stopni na 2 do 4 sekund. Najpierw wyglądało to na błąd zgadywania kursu między pomiarami GPS, ale porównanie prędkości kół z GPS (rozdział niżej) pokazuje, że w obu tych chwilach koła kręciły się o 57 i 66% szybciej, niż auto jechało, czyli były to prawdziwe uślizgi. Są też trzy zapisy z poślizgami z tego samego wieczoru (3, 2,5 i 4 minuty): w 21 miejscach koła kręciły się wyraźnie szybciej, niż auto jechało (nawet ponad dwa razy), a kąt dochodził wtedy do 16 do 26 stopni (według wersji 0.8.1), za każdym razem nosem do środka zakrętu, i wracał w okolice zera na prostych. Wersje do 0.8.0 pokazywały szczyty do 33 stopni, ale część z nich brała się ze złego zgadywania kierunku jazdy między punktami GPS w przejściach; z własnym odejmowaniem grawitacji kąt skacze kilkakrotnie rzadziej. Kierunek odniesienia trzymał się w granicach około 4 stopni. Nie ma jeszcze porównania z pomiarem wzorcowym (na przykład z dwiema antenami), więc te liczby mówią, że wynik jest sensowny, a nie jak dokładny. To nie zastąpi urządzenia z dwiema antenami RTK: jazda tyłem, długie obracanie w miejscu bez prostych i luźny uchwyt telefonu dają błędne wskazania.

**Kolor śladu** mówi, pod jakim kątem auto jechało w danym miejscu: niebieski to jazda na wprost, potem przez fiolet i róż do czerwieni przy 35 stopniach i więcej (w obie strony tak samo). Skala jest w lewym dolnym rogu mapy. Tak samo kolorowany jest ślad w widoku Replay.

**Widok 3D i płaski.** Mapa ma dwa widoki, przełączane przyciskiem **3D / 2D** na mapie. Wybór zostaje w telefonie i jest wspólny dla widoków Drift i Replay; aktualizacja do 0.9.4 raz go zapomina, więc każdy telefon zaczyna od 3D ze zdjęciami lotniczymi:

- **3D** (domyślny, ze zdjęciami lotniczymi): kamera jedzie za autem i nad nim, jak kamera za autem w grach wyścigowych. Mapa jest pochylona i obrócona tak, że kierunek jazdy wskazuje w górę ekranu, a auto jest bryłą (nadwozie, kabina z szybami, koła, światła) oświetloną z góry. Kamera podąża za kierunkiem jazdy, nie za nosem auta, więc w poślizgu auto ustawia się bokiem do kamery dokładnie pod kątem driftu. Kamera patrzy w dół pod kątem 40 stopni od pionu, więc na telefonie mapa sięga do samej górnej krawędzi (przy domyślnym powiększeniu od 100 do 180 m przed autem, zależnie od wysokości mapy) i nie ma nieba ani mgły. Dopiero na bardzo wysokim ekranie, gdzie górna krawędź leżałaby dalej, mapa kończy się 2000 pikseli przed autem pod wąskim paskiem nieba.
- **2D**: płaska mapa z północą u góry i autem na środku.

Przyciski **+** i **-** zmieniają powiększenie bieżącego widoku (każdy pamięta swoje). Zdjęcia i mapa mają najwyżej poziom 19; poziomy 20 i 21 pokazują je powiększone, co przydaje się w 3D (domyślnie 20). Auto w 3D ma rozmiar dopasowany do mapy, 1,4 raza większy od prawdziwego, żeby było dobrze widać, jak stoi. Kafelki układa i pochyla przeglądarka, a ślad i auto aplikacja maluje na nich tymi samymi rachunkami; zgodność sprawdziłem w przeglądarce co do tysięcznej piksela.

Ostatni przycisk przełącza podkład:

- **Map**: mapa OpenStreetMap, cały świat.
- **Sat**: zdjęcia lotnicze, czyli ortofotomapa z Geoportalu (GUGiK). Tylko Polska; na torze widać pojedyncze auta. Dane są otwarte: Geoportal podaje, że ortofotomapa jest bezpłatna i "możliwa do dowolnego wykorzystania". Poza Polską w miejscu zdjęć pokazuje się zwykła mapa, z dopiskiem na dole. Obiekty wojskowe (na przykład lotnisko Bemowo) są na zdjęciach celowo zamazane.

Zdjęć satelitarnych całego świata (na przykład Esri World Imagery) nie ma w aplikacji celowo: pasują do tej samej siatki kafelków i technicznie działają, ale według Esri korzystanie z nich wymaga konta ArcGIS. Gdy będzie konto i klucz, wystarczy dopisać warstwę w `src/map.js`.

Mapa pobiera kafelki z serwera OpenStreetMap albo Geoportalu, więc otwarty widok Drift lub Replay wysyła tam przybliżone położenie (numer kafelka). Sam ślad i dane nie są nigdzie wysyłane. Bez internetu mapa jest pusta, a ślad i auto są rysowane na siatce. Wybrany podkład i powiększenie są wspólne dla widoków Drift i Replay i zostają w telefonie.

Tryb **Demo** pokazuje ten widok na wymyślonym przejeździe po ósemce, na skrzyżowaniu dróg kołowania dawnego lotniska w Ułężu (Moto Park Ułęż), żeby pod Demo były też zdjęcia lotnicze.

To, co widok pokazywał, zapisuje się dziesięć razy na sekundę w pliku `phone_drift` (kierunek nadwozia, kurs, kąt driftu, prędkość obrotu, prędkość, pozycja, stan kalibracji i od wersji 0.10.0 przyspieszenie auta wzdłuż i w poprzek nadwozia), żeby dało się to sprawdzić po przejeździe.

## Widok Replay

Trzecia zakładka, **Replay**, odtwarza zapisany przejazd:

- **Replay the log in this app** bierze log, który aplikacja ma w pamięci (to samo, co zapisałby **Save**), także w trakcie trwającego zapisu. To samo robi przycisk **Replay** obok **Save** w sekcji Log.
- **Example recordings…** otwiera jeden z przejazdów dołączonych do aplikacji (folder `examples/`): jazdę po mieście i trzy przejazdy z poślizgami z 10.11.2026, BMW E39. Poślizgi były robione na zamkniętym odcinku drogi. Pliki są pobierane dopiero po wybraniu, więc bez internetu ta lista działa tylko dla przykładów otwartych wcześniej. Przykład pokazuje tylko ciekawą część: przejazd z poślizgami od sekundy przed pierwszym uślizgiem kół albo driftem do dwóch i pół sekundy po ostatnim, jazdę po mieście od ruszenia do chwili, gdy telefon został wzięty do ręki. Pod przyciskami jest napisane, od kiedy do kiedy trwał cały zapis. Kąt driftu i porównanie kół z GPS są liczone na całym nagraniu (kierunek nadwozia ustala się na prostej przed pierwszym poślizgiem), a ślad na mapie jest wygładzany przez wszystkie punkty GPS, więc auto stoi na mapie od pierwszej chwili. Całe nagranie można obejrzeć, otwierając plik z folderu `examples/` przez **Open files…**.
- **Open files…** wczytuje pliki zapisane albo udostępnione z aplikacji: archiwum `drifthing_log_*.zip` albo pojedyncze pliki CSV (można zaznaczyć kilka naraz). Strumień jest rozpoznawany po nazwie pliku (`obd_data`, `phone_gps` i tak dalej), także gdy telefon dopisał do nazwy "(1)"; plik z kolumną `rpm` jest zawsze danymi auta.

Co widać:

- **Mapa** z całym śladem i autem w miejscu odtwarzania, obróconym jak nadwozie, ze strzałką kierunku jazdy. Ślad idzie przez punkty GPS (`phone_gps`), a między nimi po krzywej, która w każdym punkcie ma kierunek i prędkość podane przez GPS (krzywa Hermite'a; GPS mierzy prędkość z przesunięcia Dopplera, dokładniej niż pozycję). Dzięki temu łuki są gładkie zamiast łamanej co sekundę, a auto jedzie po tej krzywej płynnie. Na symulowanym zakręcie o promieniu 10 m przy 36 km/h krzywa trzyma się łuku z dokładnością do 25 cm, a proste odcinki ścinały go o ponad metr. Przy postoju i bardzo wolnej jeździe kierunek z GPS jest szumem, więc brany jest z sąsiednich punktów. Auto jest obrócone tak, że kąt między nim a śladem to kąt driftu z odczytów. Ten sam sposób wygładza na żywo ślad w widoku Drift tam, gdzie akcelerometr nie wypełnia przerwy między punktami. Pozycja dociera do aplikacji około pół sekundy po tym, jak auto tam było, a odtwarzanie zna dalszy ciąg, więc auto jest stawiane tam, gdzie GPS pokaże je pół sekundy później. Gdy w nagraniu nie ma `phone_gps`, pozycja pochodzi z `phone_drift`. Przed pierwszą pozycją i w dziurach GPS mapa stoi w najbliższym znanym miejscu i pokazuje ślad bez auta. Log bez pozycji (same dane auta) odtwarza się bez mapy i jest to napisane pod przyciskami.
- **Kąt driftu jest liczony od nowa** z zapisanych czujników (orientacja telefonu, przyspieszenie, GPS, prędkość kół z auta) algorytmem bieżącej wersji aplikacji, tak samo jak na żywo. Dzięki temu stary log korzysta z późniejszych poprawek, a log z wersji bez widoku Drift też ma kąt. To, co widok Drift pokazywał w czasie jazdy, zostaje na liście sygnałów w grupie "drift view, as recorded", więc oba przebiegi da się położyć obok siebie na wykresach.
- **Odczyty**: kąt driftu, prędkość z GPS, prędkość i obroty z auta w chwili odtwarzania. Gdy koła kręcą się szybciej albo wolniej, niż auto jedzie, kafelek **Car** robi się czerwony albo niebieski i pokazuje, o ile (na przykład "wheels +82%").
- **Lista driftów** (rozwijana, pod suwakiem): każdy poślizg z godziną, czasem trwania, największym kątem i stroną, średnią prędkością, największym przyspieszeniem w g i uślizgiem kół. Dotknięcie przewija odtwarzanie na półtorej sekundy przed poślizgiem. Za drift liczy się odcinek, na którym kąt przekroczył 10 stopni i trzymał się powyżej 6 w tę samą stronę przez co najmniej 0,8 s, przy prędkości powyżej 18 km/h; zmiana strony zaczyna nowy drift.
- **Grip circle (g-g)** (rozwinięte, pod listą driftów): przyspieszenie auta w jego własnych osiach na jednym kole. W górę przyspieszanie, w dół hamowanie, w bok skręcanie (kropka w prawo: auto przyspiesza w swoją prawą stronę, jak w prawym zakręcie). Kropki to chwile z okna, które pokazują wykresy, w kolorach śladu na mapie (od niebieskiego przy jeździe prosto do czerwonego przy 35 stopniach), a duża kropka z ogonem z ostatniej sekundy to chwila odtwarzania. Okręgi są co 0,5 i 1 g; pod kołem jest bieżąca wartość z rozbiciem na części i największa w oknie. W drifcie auto jest obrócone nosem do środka zakrętu, więc siła, która zakrzywia tor, wypada w osiach auta częściowo do przodu: kropki driftu leżą w górnej połowie koła, a przy zwykłym skręcaniu na osi poziomej. Przyspieszenie liczy ten sam algorytm co kąt driftu: akcelerometr bez grawitacji obrócony do mapy, a potem do kierunku nadwozia, uśredniony z ćwierć sekundy. W symulacji zgadza się z prawdziwym co do 0,04 m/s². Jest znane, gdy akcelerometr jest już zgrany z GPS (w przykładach przez 73 do 94% jazdy). W przykładach najmocniejsza chwila driftu to 0,34 do 0,56 g, a całego przejazdu do 0,69 g. W nagraniu to kolumny `ahead_ms2` i `right_ms2`, które można też położyć na wykresach. Starsze logi dostają je przy odtwarzaniu, bo kąt driftu i tak jest liczony od nowa.
- **Summary of the drive** (rozwijane, na dole): czas nagrania bez przerw, dystans, największa prędkość z GPS i z kół, najwyższe obroty i temperatura płynu, liczba i łączny czas driftów, największy kąt, najdłuższy drift, średnia prędkość w drifcie, największe przyspieszenie (**Most grip used**), łączny czas uślizgu kół.
- **Pasy na wykresach**: czerwone tło tam, gdzie koła kręciły się szybciej, niż auto jechało, niebieskie tam, gdzie wolniej (zablokowane koła, ręczny). Pod wykresami jest ich liczba i zmierzona różnica wskazań auto/GPS. Jak to jest liczone, opisuje rozdział "Koła a GPS".
- **Play / Pause**, tempo od ×0,25 do ×16 i suwak pozycji. Przerwy w zapisie (strona w tle, postój z rozłączonym adapterem; ponad 3 sekundy bez żadnych danych) są przeskakiwane, a ich liczba jest podana pod przyciskami.
- **Wykresy**: każdy sygnał ma własny pasek z własną skalą (najmniejsza i największa wartość w całym nagraniu), a wszystkie paski mają wspólną oś czasu i wspólny kursor. Sygnał dodaje się z listy **Add a signal to the charts…** (wszystkie kolumny wszystkich plików, pogrupowane według źródła), a usuwa krzyżykiem. Przyciskiem **+** na wykresie dokłada się do niego kolejny sygnał: każdy ma swój kolor i swój wiersz z wartością nad wykresem. Sygnały o tej samej jednostce (na przykład `speed_kmh` z auta i `ground_kmh` z porównania kół z GPS) dostają wspólną skalę, więc da się je porównać wprost; sygnały o różnych jednostkach mają każdy swoją skalę, opisaną w swoim kolorze. Wybór zostaje w telefonie. Dotknięcie wykresu przenosi odtwarzanie w to miejsce. Każdy pomiar jest kropką na linii (styl "-.-"), więc widać, gdzie naprawdę były odczyty, a gdzie linia je tylko łączy. Kropki pojawiają się, gdy pomiarów w oknie jest na tyle mało, że stoją co najmniej 3 piksele od siebie (dane auta i GPS przy oknie 30 s; kąt driftu, 10 razy na sekundę, przy oknie 10 s; czujniki 60 Hz dopiero przy krótszym oknie, którego nie ma). Gdzie pomiarów jest więcej, linia jest przerzedzana z zachowaniem szczytów i kropek nie ma.
- **Charts show** ustawia, ile czasu widać na wykresach naraz: 10 s, 30 s, 2 min, 10 min albo całe nagranie. Wykres stoi w miejscu, przesuwa się kursor; gdy dojdzie do końca okna, wykresy przechodzą do następnego. W miejscu przerwy w zapisie linia jest przerwana.

Wszystkie sygnały leżą na jednej osi czasu, bo każdy plik ma `timestamp_ms` z tego samego zegara zapisu. Wartość pokazywana w danej chwili to ostatnia zmierzona przed tą chwilą. Długie sygnały (60 Hz) są na wykresie przerzedzane tak, żeby każdy szczyt i dołek został.

Odtwarzanie działa w całości w telefonie, bez internetu (poza kafelkami mapy). Archiwum z godziny jazdy to kilkadziesiąt megabajtów danych w pamięci, więc bardzo długie logi lepiej oglądać na laptopie.

## Tryb Diag

Czwarta zakładka, **Diag**, pokazuje to, co pokazuje skaner diagnostyczny: kontrolkę silnika i liczbę zapisanych kodów błędów, stan układu paliwowego (pętla otwarta czy zamknięta i dlaczego), krótko- i długoterminowe korekty paliwa dla obu rzędów cylindrów, kąt wyprzedzenia zapłonu, napięcia sond lambda i korekty, o które proszą, powietrze wtórne, standard OBD i dystans z zapaloną kontrolką. Pokazuje tylko to, co auto zgłasza; E39 zgłasza 14 takich wartości.

Te wartości są czytane tylko w trybie odczytu **Diagnostics** (przełącznik **Read from the car** albo przycisk **Read diagnostics** w zakładce). Wtedy w każdym cyklu, oprócz zwykłych wartości, czytane są po kolei trzy z nich, więc na linii K każda odświeża się co kilka sekund, a reszta odczytów zwalnia (cykl trwa około 1,7 s zamiast 0,9 s). Do jazdy w poślizgach lepiej przełączyć z powrotem. Wartość nieczytana od 30 sekund jest szara. Zapis trafia do CSV (kolumny w rozdziale Dane).

## Koła a GPS (uślizg kół)

Auto podaje prędkość z kół (w E39 wskazanie idzie za kołami napędzanymi: w poślizgu ucieka w górę), a GPS prędkość względem ziemi. Widok Replay porównuje je i zaznacza, gdzie się rozchodzą. Zanim da się je porównać, trzeba zdjąć dwie rzeczy:

- **Skala.** Licznik auta i GPS nie zgadzają się idealnie nawet na prostej (rozmiar opon, skala prędkościomierza). Stosunek auto/GPS jest mierzony na odcinkach jazdy ze stałą prędkością powyżej 18 km/h (mediana z całego nagrania; potrzeba co najmniej ośmiu takich odczytów, inaczej przyjmowane jest 1). W dotychczasowych logach wychodzi 0,992 do 0,997. Stosunek poza zakresem 0,8 do 1,25 znaczy, że to nie błąd licznika, i wtedy nic nie jest zaznaczane.
- **Opóźnienie.** Prędkość z auta jest stara, gdy dociera: na pierwszych jazdach była około pół sekundy za GPS (zmierzone przy puszczonym gazie, gdzie koła nie mogą buksować). Każdy odczyt z auta jest więc porównywany z prędkością GPS sprzed pół sekundy.

Odczyt liczy się jako **uślizg**, gdy auto pokazuje co najmniej 6 km/h i 15% więcej, niż wynika z GPS, a jako **koła wolniejsze**, gdy pokazuje co najmniej 8 km/h i 25% mniej przy prędkości powyżej 20 km/h (przy ruszaniu wskazanie auta startuje z opóźnieniem i zaniżone, więc niżej nie jest to wiarygodne). Pas na wykresie to co najmniej dwa takie odczyty z rzędu albo jeden powyżej 30%. Pasy stoją tam, gdzie są odczyty z auta, czyli około pół sekundy po tym, co naprawdę działo się z kołami.

Wyniki są też sygnałami do wykresów, w grupie "wheels against the ground": `ground_kmh` (co pokazałoby auto, gdyby koła trzymały), `excess_kmh` (o ile pokazało więcej) i `slip_pct` (to samo w procentach).

Ograniczenia: prędkość z auta to całe kilometry na godzinę, na linii K raz na 0,5 do 1 s, więc krótkie zerwanie przyczepności może umknąć. Progi dobrałem na czterech logach z jednego auta i jednego telefonu.

## GPS i RTK

Aplikacja prosi o pozycję w trybie wysokiej dokładności i bez pozycji z pamięci podręcznej. Chrome na Androidzie prosi wtedy system o pozycję co 0,5 s z najwyższym priorytetem (stałe `UPDATE_INTERVAL_FAST_MS = 500` i `PRIORITY_HIGH_ACCURACY` w źródłach Chrome), ale odbiornik w telefonie daje ją raz na sekundę. W logach z 10.11.2026 dokładność podawana przez telefon to 3 do 10 m. Strona WWW nie dostanie więcej: ani surowych pomiarów, ani częstszych pozycji, ani nie poda odbiornikowi w telefonie poprawek RTK.

Dokładność centymetrową i kierunek nadwozia z dwóch anten daje urządzenie zespołu (Raspberry z Unicore UM982, poprawki z ASG-EUPOS, repo `raspberry-unicore`). Najprostsze połączenie obu światów to wozić je razem z telefonem i zestawić logi po czasie; drugie to czytać zewnętrzny odbiornik po Bluetooth bezpośrednio w aplikacji, tak jak adapter OBD. Żadne z nich nie jest jeszcze zrobione.

## Eksport dla backendu

W widoku Replay, w rozwijanym **Summary of the drive**, przycisk **Save for the backend** zapisuje plik `drifthing_backend_RRRRMMDD_GGMMSS.csv` w formacie, który przyjmuje backend zespołu (repo `drifthing`, polecenie `csvimport`):

```bash
python manage.py csvimport --file drifthing_backend_20261110_203008.csv --commit
```

Bez `--commit` polecenie tylko sprawdza plik i wycofuje zmiany. Kolumny, dziesięć wierszy na sekundę:

- `timestamp`: czas w ISO 8601, UTC (na przykład `2026-11-10T19:31:33.925Z`),
- `location`: pozycja jako WKT `POINT(długość szerokość)` w WGS 84, z wygładzonego śladu GPS,
- `speed_kmh`: prędkość nad ziemią z GPS,
- `drift_angle`: kąt driftu w stopniach, ze znakiem (dodatni: nos w prawo od kierunku jazdy),
- `acceleration_g`: przyspieszenie poziome w g (hamowanie, przyspieszanie i zakręt razem) jako zmiana prędkości zmierzonej przez GPS między sąsiednimi punktami, czyli średnia z około sekundy, niższa od chwilowych szczytów (w dołączonych przejazdach najwyżej 0,35 g),
- `direction`: kierunek, w który wskazuje nos auta, w stopniach od północy.

Wiersze są tylko tam, gdzie znany jest kąt driftu (przed pierwszą prostą i po ruszeniu telefonu go nie ma): każda kolumna backendu musi mieć wartość, a wpisane zero udawałoby jazdę prosto. Polecenie backendu tworzy nowy przejazd zawsze dla kierowcy, urządzenia i toru o numerze 1 (tak jest zapisane w jego kodzie). Format sprawdziłem tak, jak czyta go backend: Python `csv.DictReader` i odczyt WKT; na prawdziwej bazie z Django jeszcze nie.

## Dane

Kolumny CSV: `timestamp_ms, rpm, speed_kmh, throttle_pct, pedal_pct, engine_load_pct, coolant_c, intake_air_c, maf_gs, map_kpa, oil_c, ambient_c, catalyst_c, battery_v`. Pierwsze dziesięć jest takie samo jak w loggerze na Raspberry. Ostatnia to napięcie akumulatora mierzone przez adapter. Pusta komórka oznacza, że auto nie obsługuje danej wartości albo nie była czytana w tym wierszu: na linii K wiersz to jedna wartość, na CAN cały cykl, w którym wolne wartości (obciążenie, temperatury) są czytane kolejno, jedna na sekundę. Do analizy w arkuszu albo w pandas puste komórki wypełnia się ostatnią znaną wartością (`ffill`).

Od wersji 0.9.0 po `battery_v` są kolumny trybu Diag (rozdział niżej), puste, gdy auto nie było czytane w tym trybie: `mil_on, trouble_codes, fuel_system_1, fuel_system_2, stft_b1_pct, ltft_b1_pct, stft_b2_pct, ltft_b2_pct, timing_deg`, napięcie i korekta każdej sondy lambda (`o2_b1s1_v, o2_b1s1_trim_pct` i tak dalej do `b2s4`), `secondary_air, fuel_pressure_kpa, fuel_level_pct, barometric_kpa, run_time_s, distance_mil_km, distance_cleared_km, obd_standard`. Kolumny przed nimi zostały na swoich miejscach.

Temperatury oleju (`oil_c`), powietrza na zewnątrz (`ambient_c`) i katalizatora (`catalyst_c`) są w standardzie OBD2, ale zgłaszają je głównie nowsze auta. Kafelek na ekranie pojawia się tylko wtedy, gdy auto daną wartość ma.

`timestamp_ms` to czas ze środka zapytania, na zegarze zapisu opisanym w rozdziale o czujnikach telefonu. Telefon synchronizuje zegar z siecią, więc dane da się zestawić z GNSS z urządzenia.

Aplikacja pyta auto, które wartości obsługuje, i czyta tylko te. Pełna lista wartości zgłoszonych przez auto (także tych, których aplikacja nie czyta) jest w dzienniku diagnostycznym, w wierszu "the car reports N mode 01 PIDs". Listy zgłoszone przez różne sterowniki (silnik, skrzynia) są łączone. Na CAN szybkie dane idą jednym zapytaniem, o ile auto na to pozwala; na linii K zawsze po jednej wartości.

## Czego jeszcze nie ma

- Odczyt z auta przeszedł pierwszy test (10.11.2026: BMW E39, adapter Vgate Scan, telefon z Androidem). Zapis czujników telefonu przeszedł test tego samego dnia (wersja 0.5.0, Android 10, Chrome 156, 7 minut jazdy): akcelerometr, żyroskop i orientacja bez kompasu po 57 do 60 Hz, orientacja z kompasem 40 Hz, GPS raz na sekundę, bez przerw i bez cofania się czasu. Pozycja GPS docierała do aplikacji zwykle 35 ms po pomiarze, a prędkość z auta i z GPS zgadzały się w czasie co do około 0,1 s i co do wartości co do 1%.
- Dane nie są nigdzie wysyłane. Żeby trafiały do projektu, trzeba je dopiąć do brokera MQTT (przeglądarka potrzebuje do tego MQTT po WebSocket) albo wgrywać CSV.
- Widok 3D nie był jeszcze używany w trakcie jazdy: nie wiem, jak płynnie chodzi na telefonie w aucie i ile danych zużywa (przy domyślnym powiększeniu widać naraz od 12 do 18 kafelków zdjęć). Sprawdzałem go w Chrome na komputerze (w oknie o szerokości telefonu), na Demo i na dołączonych przejazdach.
- Widok Drift był na prawdziwej jeździe dwa razy (10.11.2026): raz w wersji 0.5.0, gdzie trafił na błąd wyboru czujnika orientacji, i raz w 0.6.0 na przejeździe z poślizgami, gdzie zadziałał. Wersja z poprawką była sprawdzana na zapisach obu jazd, nie w aucie. Kąta nie porównano dotąd z żadnym pomiarem wzorcowym.
- Widok Replay był sprawdzany w Chrome na komputerze: na logu z pierwszej jazdy E39 (same dane auta), na czterech logach z jazd z czujnikami telefonu i na symulowanym przejeździe z pauzą. Na telefonie zgłoszono, że mapa się nie pokazała; od 0.6.2 mapa stoi w najbliższym znanym miejscu także wtedy, gdy w chwili odtwarzania nie ma pozycji, ale przyczyna tamtego zgłoszenia nie jest potwierdzona.
- Tryby odczytu „For drifting” i „Diagnostics” były sprawdzane na symulowanym aucie z linią K, w aucie jeszcze nie. Wartości diagnostyczne na symulatorze ustawiłem na te, które Car Scanner pokazał dla E39.
- Uślizg kół na żywo (kafelek Car w widoku Drift) ma tylko testy na sztucznych danych; w aucie nie był widziany.
- Lista driftów pokazuje to, co zmierzył telefon. Przy małych prędkościach (około 20 km/h) kąt między pomiarami GPS jest najmniej pewny, więc krótkie pozycje bez uślizgu kół przy takiej prędkości mogą być błędem pomiaru.
- Ocena akumulatora była sprawdzana na symulowanym rozruchu. Na aucie adapter łączył się dotąd przy pracującym silniku, więc widać było tylko napięcie ładowania (zwykle 14,0 V, czyli w normie), a naładowania nie.
- Hamulec i kąt skrętu kierownicy nie są standardowymi wartościami OBD2. Wymagają czytania surowych ramek konkretnego modelu auta, a w E39 protokołu BMW.

## Testy

```bash
npm test
```

Testy (Node 22, bez zależności) sprawdzają dekodowanie wartości, parsowanie odpowiedzi adaptera, sesję na symulatorze (CAN, linia K, klon odrzucający komendy, auto bez odpowiedzi, zawieszone szukanie protokołu), pętlę odczytu z ponownym łączeniem, dziennik diagnostyczny, transport Web Serial na podstawionym porcie, eksport CSV, listę plików do pracy bez serwera, service worker na podstawionym serwerze (start bez sieci, nowa wersja pobierana w całości, strona nigdy z plikami dwóch wersji, przerwane pobieranie, wolny serwer), przeładowanie strony po aktualizacji (nietknięta, w użyciu, w trakcie zapisu), wybór portu adaptera, zapis czujników telefonu na podstawionych czujnikach i GPS, format próbek, archiwum ZIP (odczytywane niezależnym kodem), arytmetykę mapy, kąt driftu na symulowanych przejazdach (dowolne mocowanie telefonu, opóźniony GPS, szum czujników, przerwa w danych), ocenę akumulatora (tabele napięć, rozruch, ładowanie), zegar zapisu (skok zegara telefonu, uśpienie), odczyt archiwum ZIP, wczytanie nagrania do odtwarzania (CSV, rzadkie wiersze z linii K, przerwy, przerzedzanie, interpolacja pozycji), drogę loga od zapisu do odtworzenia, arytmetykę wykresów i pasów, wybór czujnika orientacji, liczenie kąta driftu od nowa z nagrania (kompas z zakłóceniami, telefon bez drugiej orientacji, dwie sesje w jednym logu), porównanie kół z GPS (skala licznika, opóźnienie, uślizg, zablokowane koła, ruszanie, pojedyncze odczyty), tryb odczytu do driftu, kolory śladu, wykrywanie ruszonego telefonu, listę driftów i podsumowanie, moc z przepływu powietrza, porównanie kół z GPS na żywo, wygładzony ślad przez punkty GPS (łuk, postój, brak kursu, sprzeczny kurs, przerwy), kamerę 3D (rzutowanie w obie strony, widoczny kawałek ziemi, ziemia do górnej krawędzi na ekranie telefonu, CSS), wybór pokazywanego kawałka nagrania (od sekundy przed pierwszym uślizgiem lub driftem, od ruszenia do wzięcia telefonu), model auta 3D (które ściany widać z której strony, kolejność rysowania, oświetlenie), kropki na wykresach, odejmowanie grawitacji od surowego akcelerometru (Android zaniżający przyspieszenie), przyspieszenie w osiach auta na symulowanym przejeździe i wykres g-g (położenie na kole, opis słowami, wiersze bez przyspieszenia), kilka sygnałów na jednym wykresie (wspólna i osobne skale), plik dla backendu (na dołączonym przejeździe), wartości diagnostyczne (jak je pokazuje Car Scanner) i tryb Diag oraz cztery dołączone przejazdy przepuszczone przez całą ścieżkę odtwarzania (z zapisanymi wynikami, żeby zmiana algorytmu nie popsuła prawdziwych danych po cichu).

## Pliki

- `src/pids.js`, `src/elm327.js`, `src/poller.js`: protokół i pętla odczytu (przeniesione z loggera na Raspberry).
- `src/transports.js`: połączenie przez Web Serial. `src/simulator.js`: symulowany adapter i auto.
- `src/trace.js`: dziennik diagnostyczny rozmowy z adapterem.
- `src/backend-export.js`: plik dla backendu zespołu.
- `src/battery.js`: naładowanie akumulatora z napięcia i ocena ładowania. `src/engine.js`: moc z przepływu powietrza.
- `src/summary.js`: drifty i podsumowanie nagrania. `src/trim.js`: który kawałek przykładu pokazać. `examples/`: dołączone przejazdy i ich lista (`index.json`).
- `src/sensors.js`: czujniki ruchu i GPS telefonu. `src/samples.js`: ich próbki i zapis do CSV.
- `src/drift.js`: kierunek nadwozia, kurs i kąt driftu. `src/geo.js`, `src/map.js`: mapa. `src/camera.js`: kamera mapy (płaska i 3D). `src/car-model.js`: auto na mapie. `src/track.js`: wygładzony ślad przez punkty GPS. `src/demo-drive.js`: przejazd dla trybu Demo.
- `src/replay.js`: nagranie wczytane do odtwarzania (sygnały na wspólnej osi czasu). `src/replay-view.js`: widok Replay. `src/chart.js`: wykres jednego sygnału. `src/grip-chart.js`: wykres g-g. `src/drift-replay.js`: kąt driftu nagrania liczony od nowa z jego czujników. `src/wheels.js`: prędkość kół względem GPS.
- `src/clock.js`: zegar zapisu, wspólny dla danych auta i telefonu.
- `src/app.js`, `index.html`, `styles.css`: ekran. `src/storage.js`, `src/csv.js`, `src/zip.js`: log, eksport i odczyt archiwum.
- `sw.js`, `manifest.webmanifest`: praca bez serwera, pobieranie nowej wersji i ikona na ekranie głównym. Nowy plik aplikacji trzeba dopisać do listy w `sw.js` (pilnuje tego test). Przy każdym wydaniu trzeba podbić `APP_VERSION` w `src/app.js`, wersję w `package.json` i nazwę pamięci podręcznej (`CACHE`) w `sw.js`, która jest numerem wersji (test pilnuje, żeby się zgadzały): telefony pobierają nową wersję tylko wtedy, gdy zmienił się `sw.js`. `src/update.js`: przeładowanie strony, gdy nowa wersja jest gotowa.
- `.nojekyll`: GitHub Pages ma podawać pliki bez przetwarzania.
- `tools/make_icons.py`: generuje ikony PNG (wymaga Pillow).
