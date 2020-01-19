from datetime import datetime, timezone, timedelta
from owrx.source import SdrSource
from owrx.config import PropertyManager
import threading
import math
from abc import ABC, ABCMeta, abstractmethod

import logging

logger = logging.getLogger(__name__)


class ScheduleEntry(ABC):
    def __init__(self, startTime, endTime, profile):
        self.startTime = startTime
        self.endTime = endTime
        self.profile = profile

    def getProfile(self):
        return self.profile

    def __str__(self):
        return "{0} - {1}: {2}".format(self.startTime, self.endTime, self.profile)

    @abstractmethod
    def isCurrent(self, dt):
        pass

    @abstractmethod
    def getScheduledEnd(self):
        pass

    @abstractmethod
    def getNextActivation(self):
        pass


class TimeScheduleEntry(ScheduleEntry):
    def isCurrent(self, dt):
        time = dt.time()
        if self.startTime < self.endTime:
            return self.startTime <= time < self.endTime
        else:
            return self.startTime <= time or time < self.endTime

    def getScheduledEnd(self):
        now = datetime.utcnow()
        end = now.combine(date=now.date(), time=self.endTime)
        while end < now:
            end += timedelta(days=1)
        return end

    def getNextActivation(self):
        now = datetime.utcnow()
        start = now.combine(date=now.date(), time=self.startTime)
        while start < now:
            start += timedelta(days=1)
        return start


class DatetimeScheduleEntry(ScheduleEntry):
    def isCurrent(self, dt):
        return self.startTime <= dt < self.endTime

    def getScheduledEnd(self):
        return self.endTime

    def getNextActivation(self):
        return self.startTime

class Schedule(ABC):
    @staticmethod
    def parse(props):
        # downwards compatibility
        if "schedule" in props:
            return StaticSchedule(props["schedule"])
        elif "scheduler" in props:
            sc = props["scheduler"]
            t = sc["type"] if "type" in sc else "static"
            if t == "static":
                return StaticSchedule(sc["schedule"])
            elif t == "daylight":
                return DaylightSchedule(sc["schedule"])
            else:
                logger.warning("Invalid scheduler type: %s", t)

    @abstractmethod
    def getCurrentEntry(self):
        pass

    @abstractmethod
    def getNextEntry(self):
        pass


class TimerangeSchedule(Schedule, metaclass=ABCMeta):
    @abstractmethod
    def getEntries(self):
        pass

    def getCurrentEntry(self):
        current = [p for p in self.getEntries() if p.isCurrent(datetime.utcnow())]
        if current:
            return current[0]
        return None

    def getNextEntry(self):
        s = sorted(self.getEntries(), key=lambda e: e.getNextActivation())
        if s:
            return s[0]
        return None


class StaticSchedule(TimerangeSchedule):
    def __init__(self, scheduleDict):
        self.entries = []
        for time, profile in scheduleDict.items():
            if len(time) != 9:
                logger.warning("invalid schedule spec: %s", time)
                continue

            startTime = datetime.strptime(time[0:4], "%H%M").replace(tzinfo=timezone.utc).time()
            endTime = datetime.strptime(time[5:9], "%H%M").replace(tzinfo=timezone.utc).time()
            self.entries.append(TimeScheduleEntry(startTime, endTime, profile))

    def getEntries(self):
        return self.entries


class DaylightSchedule(TimerangeSchedule):
    def __init__(self, scheduleDict):
        self.schedule = scheduleDict

    def getSunTimes(self, date):
        pm = PropertyManager.getSharedInstance()
        lat, lng = pm["receiver_gps"]
        degtorad = math.pi / 180
        radtodeg = 180 / math.pi

        nDays = date.timetuple().tm_yday #Number of days since 01/01

        # Longitudinal correction
        longCorr = 4 * lng

        # calibrate for solstice
        b = 2 * math.pi * (nDays - 81) / 365

        # Equation of Time Correction
        eoTCorr = 9.87 * math.sin(2 * b) - 7.53 * math.cos(b) - 1.5 * math.sin(b)

        # Solar correction
        solarCorr = longCorr + eoTCorr

        # Solar declination
        delta = math.asin(math.sin(23.45 * degtorad) * math.sin(b))

        sunrise = 12 - math.acos(-math.tan(lat * degtorad) * math.tan(delta)) * radtodeg / 15 - solarCorr / 60
        sunset = 12 + math.acos(-math.tan(lat * degtorad) * math.tan(delta)) * radtodeg / 15 - solarCorr / 60

        midnight = datetime.combine(date, datetime.min.time())
        sunrise = midnight + timedelta(hours=sunrise)
        sunset = midnight + timedelta(hours=sunset)
        logger.debug("for {date} sunrise: {sunrise} sunset {sunset}".format(date=date, sunrise=sunrise, sunset=sunset))

        return sunrise, sunset

    def getEntry(self, t, profile):
        now = datetime.utcnow()
        date = now.date()
        if t == "day":
            sunrise, sunset = self.getSunTimes(date)
            if sunset < now:
                sunrise, sunset = self.getSunTimes(date + timedelta(days=1))
            return DatetimeScheduleEntry(sunrise, sunset, profile)
        elif t == "night":
            sunrise, _ = self.getSunTimes(date)
            _, sunset = self.getSunTimes(date - timedelta(days=1))
            if sunrise < now:
                sunrise, _ = self.getSunTimes(date + timedelta(days=1))
                _, sunset = self.getSunTimes(date)
            return DatetimeScheduleEntry(sunset, sunrise, profile)

    def getEntries(self):
        return [self.getEntry(t, profile) for t, profile in self.schedule.items()]


class ServiceScheduler(object):
    def __init__(self, source):
        self.source = source
        self.selectionTimer = None
        self.source.addClient(self)
        props = self.source.getProps()
        self.schedule = Schedule.parse(props)
        props.collect("center_freq", "samp_rate").wire(self.onFrequencyChange)
        self.scheduleSelection()

    def shutdown(self):
        self.cancelTimer()
        self.source.removeClient(self)

    def scheduleSelection(self, time=None):
        if self.source.getState() == SdrSource.STATE_FAILED:
            return
        seconds = 10
        if time is not None:
            delta = time - datetime.utcnow()
            seconds = delta.total_seconds()
        self.cancelTimer()
        self.selectionTimer = threading.Timer(seconds, self.selectProfile)
        self.selectionTimer.start()

    def cancelTimer(self):
        if self.selectionTimer:
            self.selectionTimer.cancel()

    def getClientClass(self):
        return SdrSource.CLIENT_BACKGROUND

    def onStateChange(self, state):
        if state == SdrSource.STATE_STOPPING:
            self.scheduleSelection()
        elif state == SdrSource.STATE_FAILED:
            self.cancelTimer()

    def onBusyStateChange(self, state):
        if state == SdrSource.BUSYSTATE_IDLE:
            self.scheduleSelection()

    def onFrequencyChange(self, name, value):
        self.scheduleSelection()

    def selectProfile(self):
        if self.source.hasClients(SdrSource.CLIENT_USER):
            logger.debug("source has active users; not touching")
            return
        logger.debug("source seems to be idle, selecting profile for background services")
        entry = self.schedule.getCurrentEntry()

        if entry is None:
            logger.debug("schedule did not return a profile. checking next entry...")
            nextEntry = self.schedule.getNextEntry()
            if nextEntry is not None:
                self.scheduleSelection(nextEntry.getNextActivation())
            return

        logger.debug("selected profile %s until %s", entry.getProfile(), entry.getScheduledEnd())
        self.scheduleSelection(entry.getScheduledEnd())

        try:
            self.source.activateProfile(entry.getProfile())
            self.source.start()
        except KeyError:
            pass