// Fuente REAL de Relume (get_component timeline10, 2026-10-14), fixture del lint. Es v4-nativa
// (size-3.75, var(--color-*)) y por eso NO entra al registry ni al scaffold. Defaults recortados.
"use client";

import { useRef } from "react";
import React from "react";
import { motion, MotionStyle, useScroll, useTransform } from "motion/react";
import clsx from "clsx";
import { Button, type ButtonProps } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ChevronRight } from "relume-icons";

type TimelineCircleProps = {
  backgroundColor: MotionStyle;
  className?: string;
};

type TimelineItem = {
  heading: string;
  title: string;
  description: string;
  buttons: ButtonProps[];
};

type Props = {
  tagline: string;
  heading: string;
  description: string;
  buttons: ButtonProps[];
  timelineItems: TimelineItem[];
};

export type Timeline10Props = React.ComponentPropsWithoutRef<"section"> & Partial<Props>;

export const Timeline10 = (props: Timeline10Props) => {
  const { tagline, heading, description, buttons, timelineItems } = {
    ...Timeline10Defaults,
    ...props,
  };

  return (
    <section className="px-[5%] py-16 md:py-24 lg:py-28">
      <div className="container">
        <div className="flex flex-col items-center">
          <div className="mb-12 text-center md:mb-18 lg:mb-20">
            <div className="relative z-10 w-full max-w-lg">
              <p className="mb-3 font-semibold md:mb-4">{tagline}</p>
              <h2 className="mb-5 text-h2 font-bold md:mb-6">{heading}</h2>
              <p className="text-medium">{description}</p>
              <div className="mt-6 flex items-center justify-center gap-x-4 md:mt-8">
                {buttons.map((button, index) => (
                  <Button key={index} {...button}>
                    {button.title}
                  </Button>
                ))}
              </div>
            </div>
          </div>
          <div className="relative grid grid-cols-1 justify-items-center gap-12 md:gap-20">
            <div className="absolute flex h-full w-8 flex-col items-center justify-self-start md:justify-self-auto">
              <div className="absolute z-10 h-16 w-1 bg-gradient-to-b from-scheme-background to-transparent" />
              <div className="sticky top-0 mt-[-50vh] h-[50vh] w-[3px] bg-scheme-text" />
              <div className="h-full w-[3px] bg-scheme-text/15" />
              <div className="absolute bottom-0 z-0 h-16 w-1 bg-gradient-to-b from-transparent to-scheme-background" />
              <div className="absolute top-[-50vh] h-[50vh] w-full bg-scheme-background" />
            </div>
            <React.Fragment>
              {timelineItems.map((item, index) => (
                <TimelineItem key={index} index={index} item={item} />
              ))}
            </React.Fragment>
          </div>
        </div>
      </div>
    </section>
  );
};

const TimelineItem = ({ item, index }: { item: TimelineItem; index: number }) => {
  const isEven = index % 2 === 0;
  const circleRef = useRef<HTMLDivElement>(null);

  const { scrollYProgress } = useScroll({
    target: circleRef,
    offset: ["start center", "start start"],
  });

  const backgroundColor = {
    backgroundColor: useTransform(
      scrollYProgress,
      [0, 0.5],
      ["var(--color-neutral)", "var(--color-scheme-text)"],
    ),
  };

  return (
    <div className="grid grid-cols-[max-content_1fr] items-start justify-items-center gap-4 md:grid-cols-[1fr_max-content_1fr] md:gap-8 lg:gap-12">
      {isEven ? (
        <React.Fragment>
          <div className="hidden w-full md:block" />
          <TimelineCircle ref={circleRef} backgroundColor={backgroundColor} />
          <TimelineContent item={item} />
        </React.Fragment>
      ) : (
        <React.Fragment>
          <TimelineContent item={item} />
          <TimelineCircle
            ref={circleRef}
            backgroundColor={backgroundColor}
            className="order-first md:order-none"
          />
          <div className="hidden w-full md:block" />
        </React.Fragment>
      )}
    </div>
  );
};

const TimelineCircle = React.forwardRef<HTMLDivElement, TimelineCircleProps>(
  ({ backgroundColor, className }, ref) => (
    <div className={clsx("flex h-full w-8 justify-center", className)}>
      <motion.div
        ref={ref}
        style={backgroundColor}
        className="z-20 mt-9 size-3.75 rounded-full shadow-[0_0_0_8px_var(--color-scheme-background)] md:mt-12"
      />
    </div>
  ),
);

const TimelineContent = ({ item }: { item: TimelineItem }) => (
  <Card className="z-20 flex flex-col p-6 md:p-8">
    <h3 className="mb-5 text-h3 font-bold md:mb-6">{item.heading}</h3>
    <h4 className="mb-3 text-h5 font-bold md:mb-4">{item.title}</h4>
    <p>{item.description}</p>
    <div className="mt-6 flex flex-wrap items-center gap-4 md:mt-8">
      {item.buttons.map((button, index) => (
        <Button key={index} {...button}>
          {button.title}
        </Button>
      ))}
    </div>
  </Card>
);

export const Timeline10Defaults: Props = {
  tagline: "Tagline",
  heading: "Medium length section heading goes here",
  description: "Lorem ipsum dolor sit amet, consectetur adipiscing elit.",
  buttons: [
    { title: "Button", variant: "secondary" },
    { title: "Button", variant: "link", size: "link", iconRight: <ChevronRight className="text-scheme-text" /> },
  ],
  timelineItems: [
    { heading: "Date", title: "Short heading here", description: "Lorem ipsum dolor sit amet.", buttons: [{ title: "Button", variant: "secondary" }] },
    { heading: "Date", title: "Short heading here", description: "Lorem ipsum dolor sit amet.", buttons: [{ title: "Button", variant: "secondary" }] },
  ],
};
